import express from 'express';
import cors from 'cors';
import { ApiPromise, WsProvider } from '@polkadot/api';
import fs from 'fs/promises';
import path from 'path';

const app = express();
app.use(cors());

// Use dedicated data directory for Docker volumes
const DATA_DIR = path.join(process.cwd(), 'data');
const CACHE_FILE = path.join(DATA_DIR, 'cache.json');
const HOLDERS_CACHE_FILE = path.join(DATA_DIR, 'holders_cache.json');
const TX_CACHE_FILE = path.join(DATA_DIR, 'transactions_cache.json');
const BLOCKS_CACHE_FILE = path.join(DATA_DIR, 'blocks_cache.json');
const EVENTS_CACHE_FILE = path.join(DATA_DIR, 'events_cache.json');
const VALIDATOR_HISTORY_CACHE_FILE = path.join(DATA_DIR, 'validator_history_cache.json');
const ACCOUNT_CACHE_FILE = path.join(DATA_DIR, 'account_history_cache.json');
const VALIDATOR_TRIGGERS_CACHE_FILE = path.join(DATA_DIR, 'validator_triggers_cache.json');

const CACHE_DEFAULTS = new Map([
    [CACHE_FILE, { validators: [], lastSync: 0, status: 'Initializing' }],
    [HOLDERS_CACHE_FILE, { holders: [], lastSync: 0, status: 'Initializing' }],
    [TX_CACHE_FILE, { transactions: [], lastSync: 0, status: 'Initializing' }],
    [BLOCKS_CACHE_FILE, { blocks: [], lastSync: 0, status: 'Initializing' }],
    [EVENTS_CACHE_FILE, { events: [], lastSync: 0, status: 'Initializing' }],
    [VALIDATOR_HISTORY_CACHE_FILE, {}],
    [ACCOUNT_CACHE_FILE, { accounts: {} }],
    [VALIDATOR_TRIGGERS_CACHE_FILE, {}]
]);
const FIVE_MINUTES = 5 * 60 * 1000;
const THIRTY_MINUTES = 30 * 60 * 1000;

let isSyncing = false;
let isSyncingHolders = false;
let isSyncingTx = false;
let isSyncingBlocks = false;
let isSyncingEvents = false;
let isCrawlingAccount = {};
let globalApi = null;
const identityCache = new Map();

// Ensure cache exists
async function initCache() {
    try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch (e) { }
    for (const [file, defaultData] of CACHE_DEFAULTS) {
        await readJsonCache(file, defaultData);
    }
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCacheData(data, defaultData) {
    const normalized = isPlainObject(data) ? { ...data } : {};
    for (const [key, fallback] of Object.entries(defaultData)) {
        if (Array.isArray(fallback)) {
            normalized[key] = Array.isArray(normalized[key]) ? normalized[key] : [...fallback];
        } else if (isPlainObject(fallback)) {
            normalized[key] = isPlainObject(normalized[key]) ? normalized[key] : { ...fallback };
        } else if (normalized[key] === undefined) {
            normalized[key] = fallback;
        }
    }
    return normalized;
}

async function readJsonCache(file, defaultData) {
    let data = defaultData;
    let needsWrite = false;
    try {
        data = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (err) {
        needsWrite = true;
    }

    const normalized = normalizeCacheData(data, defaultData);
    if (JSON.stringify(normalized) !== JSON.stringify(data)) needsWrite = true;
    if (needsWrite) await fs.writeFile(file, JSON.stringify(normalized));
    return normalized;
}

async function markCacheError(file, defaultData, err) {
    const cacheData = await readJsonCache(file, defaultData);
    cacheData.status = 'Error';
    cacheData.error = err.message;
    await fs.writeFile(file, JSON.stringify(cacheData));
}

function formatPDEX(balance) { return Number(balance) / 10 ** 12; }

function formatIdentityName(rawStr) {
    if (!rawStr) return "Unknown";
    if (rawStr.startsWith('0x')) {
        try { return Buffer.from(rawStr.slice(2), 'hex').toString('utf8'); } catch (e) { return rawStr; }
    }
    return rawStr;
}

async function getIdentity(api, address) {
    const cacheKey = address.toString();
    if (identityCache.has(cacheKey)) return identityCache.get(cacheKey);

    let name = "Unknown";
    try {
        const superOf = await api.query.identity.superOf(address);
        if (superOf.isSome) {
            const [parentAddress, data] = superOf.unwrap();
            const parentIdentity = await api.query.identity.identityOf(parentAddress);
            let parentName = "Unknown";
            const pHuman = parentIdentity.toHuman();
            if (pHuman && pHuman.info && pHuman.info.display && pHuman.info.display.Raw) parentName = formatIdentityName(pHuman.info.display.Raw);
            else if (pHuman && Array.isArray(pHuman) && pHuman[0] && pHuman[0].info) parentName = formatIdentityName(pHuman[0].info.display.Raw);

            const subDataHuman = data.toHuman();
            const subName = subDataHuman ? formatIdentityName(subDataHuman.Raw) : "Unknown";
            name = `${parentName} / ${subName}`;
        } else {
            const identity = await api.query.identity.identityOf(address);
            const human = identity.toHuman();
            if (human && human.info && human.info.display && human.info.display.Raw) name = formatIdentityName(human.info.display.Raw);
            else if (human && Array.isArray(human) && human[0] && human[0].info) name = formatIdentityName(human[0].info.display.Raw);
        }
    } catch (e) {
        console.warn(`Identity lookup failed for ${cacheKey}:`, e.message);
    }
    identityCache.set(cacheKey, name);
    return name;
}

function getBlockTimestamp(signedBlock) {
    let timestamp = Date.now();
    signedBlock.block.extrinsics.forEach((ex) => {
        if (ex.method.section === 'timestamp' && ex.method.method === 'set') timestamp = ex.method.args[0].toNumber();
    });
    return timestamp;
}

function getExtrinsicStatus(events, index) {
    const txEvents = events.filter(record => record.phase.isApplyExtrinsic && record.phase.asApplyExtrinsic.toNumber() === index);
    return txEvents.some(record => record.event.section === 'system' && record.event.method === 'ExtrinsicFailed') ? 'failed' : 'success';
}

// --- FALLBACK LIST ENDPOINTS ---
app.get('/api/validators', async (req, res) => { try { res.json(await readJsonCache(CACHE_FILE, CACHE_DEFAULTS.get(CACHE_FILE))); } catch (err) { res.json(CACHE_DEFAULTS.get(CACHE_FILE)); } });
app.get('/api/holders', async (req, res) => { try { res.json(await readJsonCache(HOLDERS_CACHE_FILE, CACHE_DEFAULTS.get(HOLDERS_CACHE_FILE))); } catch (err) { res.json(CACHE_DEFAULTS.get(HOLDERS_CACHE_FILE)); } });
app.get('/api/transactions', async (req, res) => { try { res.json(await readJsonCache(TX_CACHE_FILE, CACHE_DEFAULTS.get(TX_CACHE_FILE))); } catch (err) { res.json(CACHE_DEFAULTS.get(TX_CACHE_FILE)); } });
app.get('/api/blocks', async (req, res) => { try { res.json(await readJsonCache(BLOCKS_CACHE_FILE, CACHE_DEFAULTS.get(BLOCKS_CACHE_FILE))); } catch (err) { res.json(CACHE_DEFAULTS.get(BLOCKS_CACHE_FILE)); } });
app.get('/api/events', async (req, res) => { try { res.json(await readJsonCache(EVENTS_CACHE_FILE, CACHE_DEFAULTS.get(EVENTS_CACHE_FILE))); } catch (err) { res.json(CACHE_DEFAULTS.get(EVENTS_CACHE_FILE)); } });

// --- DETAIL ENDPOINTS (Restored) ---
app.get('/api/block/:id', async (req, res) => {
    try {
        const id = req.params.id.trim();
        let hash = id;
        if (/^\d+$/.test(id)) hash = await globalApi.rpc.chain.getBlockHash(parseInt(id));
        const signedBlock = await globalApi.rpc.chain.getBlock(hash);
        if (!signedBlock) return res.status(404).json({ error: "Block not found" });

        const timestamp = getBlockTimestamp(signedBlock);

        res.json({
            hash: signedBlock.block.header.hash.toHex(),
            date: timestamp,
            block: signedBlock.toHuman().block
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/extrinsic/:block/:txHash', async (req, res) => {
    try {
        const blockId = req.params.block.trim();
        const txHash = req.params.txHash.trim();
        let hash = blockId;
        if (/^\d+$/.test(blockId)) hash = await globalApi.rpc.chain.getBlockHash(parseInt(blockId));

        const signedBlock = await globalApi.rpc.chain.getBlock(hash);
        if (!signedBlock) return res.status(404).json({ error: "Block not found" });

        const extrinsics = signedBlock.block.extrinsics;
        let extIndex = -1;
        let targetExt = null;
        for (let i = 0; i < extrinsics.length; i++) {
            if (extrinsics[i].hash.toHex() === txHash) { extIndex = i; targetExt = extrinsics[i]; break; }
        }
        if (!targetExt) return res.status(404).json({ error: "Extrinsic not found in block" });

        const allEvents = await globalApi.query.system.events.at(hash);
        const txEvents = allEvents.filter(record => record.phase.isApplyExtrinsic && record.phase.asApplyExtrinsic.toNumber() === extIndex);

        const timestamp = getBlockTimestamp(signedBlock);
        const status = getExtrinsicStatus(allEvents, extIndex);

        res.json({
            hash: txHash,
            block: signedBlock.block.header.number.toNumber(),
            time: timestamp,
            event: `${targetExt.method.section} -> ${targetExt.method.method}`,
            from: targetExt.signer ? targetExt.signer.toString() : "System",
            to: targetExt.method.args[0] ? targetExt.method.args[0].toString() : "",
            status: status,
            extrinsic: targetExt.toHuman(),
            events: txEvents.map(e => e.toHuman().event)
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/validator/:address', async (req, res) => {
    try {
        const address = req.params.address.trim();
        let historyData = {};
        try { historyData = await readJsonCache(VALIDATOR_HISTORY_CACHE_FILE, CACHE_DEFAULTS.get(VALIDATOR_HISTORY_CACHE_FILE)); } catch (e) { }

        let identity = await getIdentity(globalApi, address);
        let controller = address;
        if (globalApi) {
            const bondedOpt = await globalApi.query.staking.bonded(address);
            if (bondedOpt && bondedOpt.isSome) controller = bondedOpt.unwrap().toString();
        }

        const eras = Object.keys(historyData).map(Number).sort((a, b) => b - a);
        const history = [];
        for (const era of eras) {
            if (historyData[era] && historyData[era][address]) {
                history.push({ era: era, commission: historyData[era][address].commission, stake: historyData[era][address].stake, apy: historyData[era][address].apy });
            }
        }

        let triggers = [];
        try {
            const triggersCache = await readJsonCache(VALIDATOR_TRIGGERS_CACHE_FILE, CACHE_DEFAULTS.get(VALIDATOR_TRIGGERS_CACHE_FILE));
            if (triggersCache[address]) triggers = triggersCache[address].sort((a, b) => b.era - a.era);
        } catch (e) { }

        res.json({ address: address, identity: identity, controller: controller, history: history, triggers: triggers });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/search/:query', async (req, res) => {
    const q = req.params.query.trim();
    if (!globalApi) return res.status(500).json({ error: 'API not ready' });
    try {
        if (/^\d+$/.test(q)) {
            const hash = await globalApi.rpc.chain.getBlockHash(parseInt(q));
            if (hash && !hash.isEmpty) {
                const derivedBlock = await globalApi.derive.chain.getBlock(hash);
                if (derivedBlock) return res.json({ type: 'block', data: { number: parseInt(q), hash: hash.toHex(), authorAddress: derivedBlock.author ? derivedBlock.author.toString() : "System", extrinsicsCount: derivedBlock.block.extrinsics.length, eventsCount: derivedBlock.events ? derivedBlock.events.length : 0 } });
            }
        }
        if (q.startsWith('0x') && q.length === 66) {
            try {
                const derivedBlock = await globalApi.derive.chain.getBlock(q);
                if (derivedBlock) return res.json({ type: 'block', data: { number: derivedBlock.block.header.number.toNumber(), hash: q, authorAddress: derivedBlock.author ? derivedBlock.author.toString() : "System", extrinsicsCount: derivedBlock.block.extrinsics.length, eventsCount: derivedBlock.events ? derivedBlock.events.length : 0 } });
            } catch (e) { }
        }
        try {
            const accountInfo = await globalApi.query.system.account(q);
            const name = await getIdentity(globalApi, q);
            const free = Number(accountInfo.data.free) / 10 ** 12;
            const reserved = Number(accountInfo.data.reserved) / 10 ** 12;
            if (free > 0 || reserved > 0 || name !== "Unknown") return res.json({ type: 'account', data: { address: q, name: name, balance: free + reserved, free: free, reserved: reserved } });
        } catch (e) { }
        res.status(404).json({ error: 'No exact deep network match found.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/account/:address', async (req, res) => {
    const address = req.params.address.trim();
    if (!globalApi) return res.status(500).json({ error: 'API not ready' });
    try {
        const accountInfo = await globalApi.query.system.account(address);
        const name = await getIdentity(globalApi, address);
        const free = Number(accountInfo.data.free) / 10 ** 12;
        const reserved = Number(accountInfo.data.reserved) / 10 ** 12;

        let txs = [], evs = [], rank = "0", status = 'Synced';
        try {
            const holdersArray = (await readJsonCache(HOLDERS_CACHE_FILE, CACHE_DEFAULTS.get(HOLDERS_CACHE_FILE))).holders;
            const index = holdersArray.findIndex(h => h.address === address);
            if (index !== -1) rank = (index + 1).toString();
        } catch (e) { }
        try {
            const accCache = await readJsonCache(ACCOUNT_CACHE_FILE, CACHE_DEFAULTS.get(ACCOUNT_CACHE_FILE));
            if (accCache.accounts[address]) {
                txs = accCache.accounts[address].transactions || [];
                evs = accCache.accounts[address].events || [];
                status = accCache.accounts[address].status || 'Synced';
            }
        } catch (e) { }

        res.json({ account: address, display: name, balanceTotal: free + reserved, balanceFree: free, balanceFrozen: reserved, roles: "User", rank: rank, transactions: txs, events: evs, status: status });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- BACKGROUND CRAWLERS ---
async function syncData() {
    if (isSyncing || !globalApi) return;
    isSyncing = true;
    try {
        console.log("Starting validator indexer sync...");
        const activeEraOption = await globalApi.query.staking.activeEra();
        const activeEra = activeEraOption.isSome ? activeEraOption.unwrap().index.toNumber() : 0;
        const validators = await globalApi.query.session.validators();
        const validatorData = [];

        for (const address of validators) {
            const addrStr = address.toString();
            const name = await getIdentity(globalApi, address);
            let totalStake = 0;

            if (globalApi.query.staking.erasStakersOverview) {
                const overviewOpt = await globalApi.query.staking.erasStakersOverview(activeEra, address);
                if (overviewOpt.isSome) totalStake = overviewOpt.unwrap().total;
            } else if (globalApi.query.staking.erasStakers) {
                const exposure = await globalApi.query.staking.erasStakers(activeEra, address);
                totalStake = exposure.total;
            }
            totalStake = totalStake.unwrap ? totalStake.unwrap() : totalStake;

            const prefs = await globalApi.query.staking.validators(address);
            let rawCommission = prefs.commission ? (prefs.commission.unwrap ? prefs.commission.unwrap().toNumber() : prefs.commission.toNumber()) : 0;
            const commissionPct = (rawCommission / 1000000000) * 100;
            const currentApy = 23.09 * (1 - (commissionPct / 100));

            validatorData.push({ address: addrStr, name: name, totalStake: formatPDEX(totalStake), commission: commissionPct, realApy: currentApy, avg30DayApy: currentApy });
        }
        await fs.writeFile(CACHE_FILE, JSON.stringify({ validators: validatorData, totalCount: validators.length, lastSync: Date.now(), status: 'Synced' }));
    } catch (err) {
        console.error("Validator sync error:", err);
        await markCacheError(CACHE_FILE, CACHE_DEFAULTS.get(CACHE_FILE), err);
    } finally { isSyncing = false; }
}

async function syncHolders() {
    if (isSyncingHolders || !globalApi) return;
    isSyncingHolders = true;
    try {
        console.log("Starting holder indexer sync...");
        const entries = await globalApi.query.system.account.entries();
        const totalIssuance = formatPDEX(await globalApi.query.balances.totalIssuance());
        const balances = entries.map(([key, data]) => ({ address: key.args[0].toString(), free: Number(data.data.free) / 10 ** 12, reserved: Number(data.data.reserved) / 10 ** 12 }))
            .sort((a, b) => (b.free + b.reserved) - (a.free + a.reserved));

        const topHolders = balances.slice(0, 500);
        const holderData = [];
        for (let i = 0; i < topHolders.length; i++) {
            const h = topHolders[i];
            const name = await getIdentity(globalApi, h.address);
            const total = h.free + h.reserved;
            holderData.push({ rank: i + 1, address: h.address, name: name, balance: total, share: (total / totalIssuance) * 100 });
        }
        await fs.writeFile(HOLDERS_CACHE_FILE, JSON.stringify({ holders: holderData, totalCount: entries.length, lastSync: Date.now(), status: 'Synced' }));
    } catch (err) {
        console.error("Holder sync error:", err);
        await markCacheError(HOLDERS_CACHE_FILE, CACHE_DEFAULTS.get(HOLDERS_CACHE_FILE), err);
    } finally { isSyncingHolders = false; }
}

async function syncBlocks() {
    if (isSyncingBlocks || !globalApi) return;
    isSyncingBlocks = true;
    try {
        let cacheData = { blocks: [], status: 'Syncing' };
        cacheData = await readJsonCache(BLOCKS_CACHE_FILE, CACHE_DEFAULTS.get(BLOCKS_CACHE_FILE));
        let currentHash = await globalApi.rpc.chain.getBlockHash();
        let blocksSearched = 0;
        const newBlocks = cacheData.blocks ? [...cacheData.blocks] : [];

        while (blocksSearched < 50) {
            try {
                const derivedBlock = await globalApi.derive.chain.getBlock(currentHash);
                if (derivedBlock) {
                    const blockNumber = derivedBlock.block.header.number.toNumber();
                    if (!newBlocks.find(b => b.number === blockNumber)) {
                        const timestamp = getBlockTimestamp(derivedBlock);
                        let authorAddr = derivedBlock.author ? derivedBlock.author.toString() : "System";
                        newBlocks.push({ number: blockNumber, hash: derivedBlock.block.header.hash.toHex(), authorAddress: authorAddr, authorName: await getIdentity(globalApi, authorAddr), extrinsicsCount: derivedBlock.block.extrinsics.length, eventsCount: derivedBlock.events ? derivedBlock.events.length : 0, timestamp: timestamp });
                    } else break;
                    currentHash = derivedBlock.block.header.parentHash;
                } else break;
            } catch (e) {
                console.warn("Block crawler stopped early:", e.message);
                break;
            }
            blocksSearched++;
        }
        cacheData.blocks = newBlocks.sort((a, b) => b.number - a.number).slice(0, 200);
        cacheData.status = 'Synced';
        delete cacheData.error;
        await fs.writeFile(BLOCKS_CACHE_FILE, JSON.stringify(cacheData));
    } catch (err) {
        console.error("Block sync error:", err);
        await markCacheError(BLOCKS_CACHE_FILE, CACHE_DEFAULTS.get(BLOCKS_CACHE_FILE), err);
    } finally { isSyncingBlocks = false; }
}

async function syncTransactions() {
    if (isSyncingTx || !globalApi) return;
    isSyncingTx = true;
    try {
        let cacheData = { transactions: [], status: 'Syncing' };
        cacheData = await readJsonCache(TX_CACHE_FILE, CACHE_DEFAULTS.get(TX_CACHE_FILE));
        let currentHash = await globalApi.rpc.chain.getBlockHash();
        let blocksSearched = 0;
        const newTransactions = cacheData.transactions ? [...cacheData.transactions] : [];

        while (blocksSearched < 50) {
            try {
                const signedBlock = await globalApi.rpc.chain.getBlock(currentHash);
                const allEvents = await globalApi.query.system.events.at(currentHash);
                const blockNumber = signedBlock.block.header.number.toNumber();
                const timestamp = getBlockTimestamp(signedBlock);

                signedBlock.block.extrinsics.forEach((ex, index) => {
                    if (ex.isSigned) {
                        const hash = ex.hash.toHex();
                        const txData = {
                            hash,
                            from: ex.signer.toString(),
                            to: ex.method.args[0] ? ex.method.args[0].toString() : "System",
                            block: blockNumber,
                            amount: "Tx",
                            numericAmount: 0,
                            value: '0$',
                            status: getExtrinsicStatus(allEvents, index),
                            timestamp: timestamp
                        };
                        const existingTx = newTransactions.find(t => t.hash === hash);
                        if (existingTx) Object.assign(existingTx, txData);
                        else newTransactions.push(txData);
                    }
                });
                currentHash = signedBlock.block.header.parentHash;
            } catch (e) {
                console.warn("Transaction crawler stopped early:", e.message);
                break;
            }
            blocksSearched++;
        }
        cacheData.transactions = newTransactions.sort((a, b) => b.timestamp - a.timestamp).slice(0, 500);
        cacheData.status = 'Synced';
        delete cacheData.error;
        await fs.writeFile(TX_CACHE_FILE, JSON.stringify(cacheData));
    } catch (err) {
        console.error("Transaction sync error:", err);
        await markCacheError(TX_CACHE_FILE, CACHE_DEFAULTS.get(TX_CACHE_FILE), err);
    } finally { isSyncingTx = false; }
}

async function syncEvents() {
    if (isSyncingEvents || !globalApi) return;
    isSyncingEvents = true;
    try {
        let cacheData = { events: [], status: 'Syncing' };
        cacheData = await readJsonCache(EVENTS_CACHE_FILE, CACHE_DEFAULTS.get(EVENTS_CACHE_FILE));
        let currentHash = await globalApi.rpc.chain.getBlockHash();
        let blocksSearched = 0;
        const newEvents = cacheData.events ? cacheData.events.filter(e => e.blockHash) : [];

        while (blocksSearched < 50) {
            try {
                const signedBlock = await globalApi.rpc.chain.getBlock(currentHash);
                const allEvents = await globalApi.query.system.events.at(currentHash);
                const blockNumber = signedBlock.block.header.number.toNumber();
                const timestamp = getBlockTimestamp(signedBlock);
                const blockHash = signedBlock.block.header.hash.toHex();

                for (let eventIndex = 0; eventIndex < allEvents.length; eventIndex++) {
                    const record = allEvents[eventIndex];
                    const eventId = `${blockHash}-${eventIndex}`;
                    if (newEvents.find(e => e.hash === eventId)) continue;

                    const extrinsicIndex = record.phase.isApplyExtrinsic ? record.phase.asApplyExtrinsic.toNumber() : null;
                    const extrinsic = extrinsicIndex !== null ? signedBlock.block.extrinsics[extrinsicIndex] : null;
                    const signerAddress = extrinsic && extrinsic.isSigned ? extrinsic.signer.toString() : "System";
                    const txHash = extrinsic ? extrinsic.hash.toHex() : "";
                    const status = record.event.section === 'system' && record.event.method === 'ExtrinsicFailed' ? 'failed' : 'success';
                    const signerName = signerAddress !== "System" ? await getIdentity(globalApi, signerAddress) : "System";

                    newEvents.push({
                        hash: eventId,
                        txHash,
                        blockHash,
                        block: blockNumber,
                        eventIndex,
                        extrinsicIndex,
                        section: record.event.section,
                        method: record.event.method,
                        data: record.event.data.toHuman(),
                        signerAddress,
                        signerName,
                        timestamp,
                        status
                    });
                    }
                currentHash = signedBlock.block.header.parentHash;
            } catch (e) {
                console.warn("Event crawler stopped early:", e.message);
                break;
            }
            blocksSearched++;
        }
        cacheData.events = newEvents.sort((a, b) => b.timestamp - a.timestamp).slice(0, 500);
        cacheData.status = 'Synced';
        delete cacheData.error;
        await fs.writeFile(EVENTS_CACHE_FILE, JSON.stringify(cacheData));
    } catch (err) {
        console.error("Event sync error:", err);
        await markCacheError(EVENTS_CACHE_FILE, CACHE_DEFAULTS.get(EVENTS_CACHE_FILE), err);
    } finally { isSyncingEvents = false; }
}

async function start() {
    await initCache();
    const wsProvider = new WsProvider('wss://so.polkadex.ee');
    globalApi = await ApiPromise.create({ provider: wsProvider });
    console.log("Connected to Polkadex RPC");

    app.listen(3001, () => {
        console.log("Backend indexer listening on port 3001");
    });

    syncData();
    syncHolders();
    syncBlocks();
    syncTransactions();
    syncEvents();

    // Sync lightweight recent-chain caches every 5 minutes. Holder ranking scans all accounts, so it runs less often.
    setInterval(() => {
        syncData();
        syncBlocks();
        syncTransactions();
        syncEvents();
    }, FIVE_MINUTES);
    setInterval(syncHolders, THIRTY_MINUTES);
}

start();
