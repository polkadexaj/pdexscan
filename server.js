import express from 'express';
import cors from 'cors';
import { ApiPromise, WsProvider } from '@polkadot/api';
import fs from 'fs/promises';
import path from 'path';

const app = express();
app.use(cors());

// Use a dedicated data directory to prevent Docker volume conflicts
const DATA_DIR = path.join(process.cwd(), 'data');
const CACHE_FILE = path.join(DATA_DIR, 'cache.json');
const HOLDERS_CACHE_FILE = path.join(DATA_DIR, 'holders_cache.json');
const VALIDATOR_HISTORY_CACHE_FILE = path.join(DATA_DIR, 'validator_history_cache.json');

const SUBQUERY_URL = 'https://sq-indexer.polkadex.ee';
let globalApi = null;
let isSyncing = false;
let isSyncingHolders = false;

// Ensure cache directory exists
async function initCache() {
    try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch (e) { }
    try { await fs.access(CACHE_FILE); } catch { await fs.writeFile(CACHE_FILE, JSON.stringify({ validators: [], lastSync: 0, status: 'Initializing' })); }
    try { await fs.access(HOLDERS_CACHE_FILE); } catch { await fs.writeFile(HOLDERS_CACHE_FILE, JSON.stringify({ holders: [], lastSync: 0, status: 'Initializing' })); }
}

function formatPDEX(balance) { return Number(balance) / 10 ** 12; }

async function fetchSubQuery(query) {
    const response = await fetch(SUBQUERY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
    });
    if (!response.ok) throw new Error(`SubQuery Error: ${response.statusText}`);
    return await response.json();
}

// --- HISTORICAL DATA ROUTES (Powered by SubQuery) ---

app.get('/api/blocks', async (req, res) => {
    try {
        const query = `
            query {
                blocks(first: 200, orderBy: NUMBER_DESC) {
                    nodes {
                        id
                        number
                        hash
                        timestamp
                    }
                }
            }
        `;
        const sqData = await fetchSubQuery(query);
        const blocks = sqData.data.blocks.nodes.map(b => ({
            number: parseInt(b.number),
            hash: b.hash,
            authorAddress: "System", // Or map from SubQuery if indexed
            authorName: "System",
            extrinsicsCount: 0, // SubQuery schemas vary, defaulting for UI safety
            eventsCount: 0,
            timestamp: new Date(b.timestamp).getTime()
        }));

        res.json({ blocks, status: 'Synced' });
    } catch (err) {
        console.error("SubQuery Blocks Error:", err.message);
        res.json({ blocks: [], status: 'Syncing', error: err.message });
    }
});

app.get('/api/transactions', async (req, res) => {
    try {
        const query = `
            query {
                extrinsics(first: 200, orderBy: BLOCK_NUMBER_DESC, filter: { isSigned: { equalTo: true } }) {
                    nodes {
                        id
                        hash
                        blockId
                        signer
                        method
                        section
                        timestamp
                        success
                    }
                }
            }
        `;
        const sqData = await fetchSubQuery(query);
        const transactions = sqData.data.extrinsics.nodes.map(tx => ({
            hash: tx.hash,
            from: tx.signer,
            to: tx.method, // Can be mapped deeper based on exact SQ schema
            block: parseInt(tx.blockId),
            amount: "Tx",
            numericAmount: 0,
            value: '0$',
            status: tx.success ? 'success' : 'failed',
            timestamp: new Date(tx.timestamp).getTime()
        }));

        res.json({ transactions, status: 'Synced' });
    } catch (err) {
        console.error("SubQuery Txs Error:", err.message);
        res.json({ transactions: [], status: 'Syncing' });
    }
});

app.get('/api/events', async (req, res) => {
    try {
        const query = `
            query {
                events(first: 200, orderBy: BLOCK_NUMBER_DESC) {
                    nodes {
                        id
                        blockId
                        section
                        method
                        timestamp
                    }
                }
            }
        `;
        const sqData = await fetchSubQuery(query);
        const events = sqData.data.events.nodes.map(ev => ({
            hash: ev.id,
            block: parseInt(ev.blockId),
            section: ev.section,
            method: ev.method,
            signerAddress: "System",
            signerName: "Unknown",
            timestamp: new Date(ev.timestamp).getTime(),
            status: 'success'
        }));
        res.json({ events, status: 'Synced' });
    } catch (err) {
        res.json({ events: [], status: 'Syncing' });
    }
});

// --- LIVE STATE INDEXERS (Powered by @polkadot/api RPC) ---

async function syncData() {
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

            // Fixed for Substrate Runtime Upgrades
            if (globalApi.query.staking.erasStakersOverview) {
                const overviewOpt = await globalApi.query.staking.erasStakersOverview(activeEra, address);
                if (overviewOpt.isSome) totalStake = overviewOpt.unwrap().total;
            } else if (globalApi.query.staking.erasStakers) {
                const exposure = await globalApi.query.staking.erasStakers(activeEra, address);
                totalStake = exposure.total;
            }

            const prefs = await globalApi.query.staking.validators(address);
            let rawCommission = prefs.commission ? prefs.commission.unwrap ? prefs.commission.unwrap().toNumber() : prefs.commission.toNumber() : 0;
            const commissionPct = (rawCommission / 1000000000) * 100;

            validatorData.push({
                address: addrStr,
                name: addrStr.substring(0, 8), // Replaced heavy identity fetch for speed
                totalStake: formatPDEX(totalStake),
                commission: commissionPct,
                realApy: 23.09 * (1 - (commissionPct / 100)),
                avg30DayApy: 23.09 * (1 - (commissionPct / 100))
            });
        }

        await fs.writeFile(CACHE_FILE, JSON.stringify({ validators: validatorData, totalCount: validators.length, lastSync: Date.now(), status: 'Synced' }));
        console.log(`Synced ${validatorData.length} validators.`);
    } catch (err) {
        console.error("Validator Sync error:", err);
    } finally {
        isSyncing = false;
    }
}

app.get('/api/validators', async (req, res) => {
    try { res.json(JSON.parse(await fs.readFile(CACHE_FILE, 'utf8'))); }
    catch (err) { res.json({ validators: [], status: 'Syncing' }); }
});

async function start() {
    await initCache();
    const wsProvider = new WsProvider('wss://so.polkadex.ee');
    globalApi = await ApiPromise.create({ provider: wsProvider });
    console.log("Connected to Polkadex RPC. Using SubQuery for historical data.");

    app.listen(3001, () => {
        console.log("Backend indexer listening on port 3001");
    });

    await syncData();
    setInterval(syncData, 10 * 60 * 1000);
}

start();