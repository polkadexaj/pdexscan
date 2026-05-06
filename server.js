import express from 'express';
import cors from 'cors';
import { ApiPromise, WsProvider } from '@polkadot/api';
import fs from 'fs/promises';
import path from 'path';

const app = express();
app.use(cors());

// Use a dedicated data folder for Docker volumes
const DATA_DIR = path.join(process.cwd(), 'data');
const CACHE_FILE = path.join(DATA_DIR, 'cache.json');
const HOLDERS_CACHE_FILE = path.join(DATA_DIR, 'holders_cache.json');
const TX_CACHE_FILE = path.join(DATA_DIR, 'transactions_cache.json');
const BLOCKS_CACHE_FILE = path.join(DATA_DIR, 'blocks_cache.json');
const EVENTS_CACHE_FILE = path.join(DATA_DIR, 'events_cache.json');
const VALIDATOR_HISTORY_CACHE_FILE = path.join(DATA_DIR, 'validator_history_cache.json');

let isSyncing = false;
let isSyncingBlocks = false;
let isSyncingTx = false;
let isSyncingEvents = false;
let globalApi = null;

async function initCache() {
    try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch (e) { }
    const files = [CACHE_FILE, HOLDERS_CACHE_FILE, TX_CACHE_FILE, BLOCKS_CACHE_FILE, EVENTS_CACHE_FILE, VALIDATOR_HISTORY_CACHE_FILE];
    for (const file of files) {
        try { await fs.access(file); } catch { await fs.writeFile(file, JSON.stringify({ status: 'Initializing' })); }
    }
}

// Fallback API Endpoints to prevent frontend crashes
app.get('/api/validators', async (req, res) => { try { res.json(JSON.parse(await fs.readFile(CACHE_FILE, 'utf8'))); } catch (err) { res.json({ validators: [], status: 'Syncing' }); } });
app.get('/api/holders', async (req, res) => { try { res.json(JSON.parse(await fs.readFile(HOLDERS_CACHE_FILE, 'utf8'))); } catch (err) { res.json({ holders: [], status: 'Syncing' }); } });
app.get('/api/blocks', async (req, res) => { try { res.json(JSON.parse(await fs.readFile(BLOCKS_CACHE_FILE, 'utf8'))); } catch (err) { res.json({ blocks: [], status: 'Syncing' }); } });
app.get('/api/transactions', async (req, res) => { try { res.json(JSON.parse(await fs.readFile(TX_CACHE_FILE, 'utf8'))); } catch (err) { res.json({ transactions: [], status: 'Syncing' }); } });
app.get('/api/events', async (req, res) => { try { res.json(JSON.parse(await fs.readFile(EVENTS_CACHE_FILE, 'utf8'))); } catch (err) { res.json({ events: [], status: 'Syncing' }); } });

// --- CRAWLERS ---

async function syncValidators() {
    if (isSyncing || !globalApi) return;
    isSyncing = true;
    try {
        console.log("Syncing active validators...");
        const activeEraOption = await globalApi.query.staking.activeEra();
        const activeEra = activeEraOption.isSome ? activeEraOption.unwrap().index.toNumber() : 0;
        const validators = await globalApi.query.session.validators();
        const validatorData = [];

        for (const address of validators) {
            const addrStr = address.toString();
            let totalStake = 0;

            // Substrate Runtime Upgrade Fix
            if (globalApi.query.staking.erasStakersOverview) {
                const overviewOpt = await globalApi.query.staking.erasStakersOverview(activeEra, address);
                if (overviewOpt.isSome) totalStake = overviewOpt.unwrap().total;
            } else if (globalApi.query.staking.erasStakers) {
                const exposure = await globalApi.query.staking.erasStakers(activeEra, address);
                totalStake = exposure.total;
            }

            const prefs = await globalApi.query.staking.validators(address);
            let rawCommission = prefs.commission ? (prefs.commission.unwrap ? prefs.commission.unwrap().toNumber() : prefs.commission.toNumber()) : 0;
            const commissionPct = (rawCommission / 1000000000) * 100;

            validatorData.push({
                address: addrStr,
                name: addrStr.substring(0, 8), // Fast identity
                totalStake: Number(totalStake) / 10 ** 12,
                commission: commissionPct,
                realApy: 23.09 * (1 - (commissionPct / 100)),
                avg30DayApy: 23.09 * (1 - (commissionPct / 100))
            });
        }
        await fs.writeFile(CACHE_FILE, JSON.stringify({ validators: validatorData, totalCount: validators.length, lastSync: Date.now(), status: 'Synced' }));
    } catch (err) { console.error("Validator Sync error:", err); } finally { isSyncing = false; }
}

async function syncBlocks() {
    if (isSyncingBlocks || !globalApi) return;
    isSyncingBlocks = true;
    try {
        let cacheData = { blocks: [], status: 'Syncing' };
        try { cacheData = JSON.parse(await fs.readFile(BLOCKS_CACHE_FILE, 'utf8')); } catch (e) { }

        let currentHash = await globalApi.rpc.chain.getBlockHash();
        let blocksSearched = 0;
        const newBlocks = cacheData.blocks ? [...cacheData.blocks] : [];

        // Continuous crawler: search top 50 blocks every interval to catch updates
        while (blocksSearched < 50) {
            try {
                const derivedBlock = await globalApi.derive.chain.getBlock(currentHash);
                if (derivedBlock) {
                    const blockNumber = derivedBlock.block.header.number.toNumber();
                    if (!newBlocks.find(b => b.number === blockNumber)) {
                        newBlocks.push({
                            number: blockNumber,
                            hash: derivedBlock.block.header.hash.toHex(),
                            authorAddress: derivedBlock.author ? derivedBlock.author.toString() : "System",
                            extrinsicsCount: derivedBlock.block.extrinsics.length,
                            eventsCount: derivedBlock.events ? derivedBlock.events.length : 0,
                            timestamp: Date.now()
                        });
                    } else { break; } // Caught up to cached history
                    currentHash = derivedBlock.block.header.parentHash;
                } else { break; }
            } catch (e) { break; }
            blocksSearched++;
        }

        cacheData.blocks = newBlocks.sort((a, b) => b.number - a.number).slice(0, 200);
        cacheData.status = 'Synced';
        await fs.writeFile(BLOCKS_CACHE_FILE, JSON.stringify(cacheData));
    } catch (err) { } finally { isSyncingBlocks = false; }
}

async function start() {
    await initCache();
    const wsProvider = new WsProvider('wss://so.polkadex.ee');
    globalApi = await ApiPromise.create({ provider: wsProvider });
    console.log("Connected to Polkadex RPC");

    app.listen(3001, () => { console.log("Backend indexer listening on port 3001"); });

    syncValidators();
    syncBlocks();

    // Continuous sync loop
    setInterval(() => {
        syncValidators();
        syncBlocks();
        // Add your other sync functions here...
    }, 5 * 60 * 1000); // Check every 5 mins
}
start();