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

let isSyncing = false;
let isSyncingHolders = false;
let isSyncingTx = false;
let isSyncingBlocks = false;
let isSyncingEvents = false;
let isCrawlingAccount = {};
let globalApi = null;

// Ensure cache exists
async function initCache() {
    try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch (e) { }
    const files = [
        { path: CACHE_FILE, default: { validators: [], lastSync: 0, status: 'Initializing' } },
        { path: HOLDERS_CACHE_FILE, default: { holders: [], lastSync: 0, status: 'Initializing' } },
        { path: TX_CACHE_FILE, default: { transactions: [], lastSync: 0, status: 'Initializing' } },
        { path: BLOCKS_CACHE_FILE, default: { blocks: [], lastSync: 0, status: 'Initializing' } },
        { path: EVENTS_CACHE_FILE, default: { events: [], lastSync: 0, status: 'Initializing' } },
        { path: VALIDATOR_HISTORY_CACHE_FILE, default: {} },
        { path: ACCOUNT_CACHE_FILE, default: { accounts: {} } },
        { path: VALIDATOR_TRIGGERS_CACHE_FILE, default: {} }
    ];
    for (const f of files) {
        try { await fs.access(f.path); } catch { await fs.writeFile(f.path, JSON.stringify(f.default)); }
    }
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
    } catch (e) { }
    return name;
}

// --- FALLBACK LIST ENDPOINTS ---
app.get('/api/validators', async (req, res) => { try { res.json(JSON.parse(await fs.readFile(CACHE_FILE, 'utf8'))); } catch (err) { res.json({ validators: [], status: 'Syncing' }); } });
app.get('/api/holders', async (req, res) => { try { res.json(JSON.parse(await fs.readFile(HOLDERS_CACHE_FILE, 'utf8'))); } catch (err) { res.json({ holders: [], status: 'Syncing' }); } });
app.get('/api/transactions', async (req, res) => { try { res.json(JSON.parse(await fs.readFile(TX_CACHE_FILE, 'utf8'))); } catch (err) { res.json({ transactions: [], status: 'Syncing' }); } });
app.get('/api/blocks', async (req, res) => { try { res.json(JSON.parse(await fs.readFile(BLOCKS_CACHE_FILE, 'utf8'))); } catch (err) { res.json({ blocks: [], status: 'Syncing' }); } });
app.get('/api/events', async (req, res) => { try { res.json(JSON.parse(await fs.readFile(EVENTS_CACHE_FILE, 'utf8'))); } catch (err) { res.json({ events: [], status: 'Syncing' }); } });

// --- DETAIL ENDPOINTS (Restored) ---
app.get('/api/block/:id', async (req, res) => {
    try {
        const id = req.params.id.trim();
        let hash = id;
        if (/^\d+$/.test(id)) hash = await globalApi.rpc.chain.getBlockHash(parseInt(id));
        const signedBlock = await globalApi.rpc.chain.getBlock(hash);
        if (!signedBlock) return res.status(404).json({ error: "Block not found" });

        let timestamp = Date.now();
        signedBlock.block.extrinsics.forEach((ex) => {
            if (ex.method.section === 'timestamp' && ex.method.method === 'set') timestamp = ex.method.args[0].toNumber();
        });

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

        let timestamp = Date.now();
        signedBlock.block.extrinsics.forEach((ex) => {
            if (ex.method.section === 'timestamp' && ex.method.method === 'set') timestamp = ex.method.args[0].toNumber();
        });

        let status = "success";
        txEvents.forEach(e => { if (e.event.section === 'system' && e.event.method === 'ExtrinsicFailed') status = "failed"; });

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
        try { historyData = JSON.parse(await fs.readFile(VALIDATOR_HISTORY_CACHE_FILE, 'utf8')); } catch (e) { }

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
            const triggersCache = JSON.parse(await fs.readFile(VALIDATOR_TRIGGERS_CACHE_FILE, 'utf8'));
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
            const holdersArray = JSON.parse(await fs.readFile(HOLDERS_CACHE_FILE, 'utf8')).holders;
            const index = holdersArray.findIndex(h => h.address === address);
            if (index !== -1) rank = (index + 1).toString();
        } catch (e) { }
        try {
            const accCache = JSON.parse(await fs.readFile(ACCOUNT_CACHE_FILE, 'utf8'));
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
    } catch (err) { } finally { isSyncing = false; }
}

async function syncHolders() {
    if (isSyncingHolders || !globalApi) return;
    isSyncingHolders = true;
    try {
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
    } catch (err) { } finally { isSyncingHolders = false; }
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

        while (blocksSearched < 50) {
            try {
                const derivedBlock = await globalApi.derive.chain.getBlock(currentHash);
                if (derivedBlock) {
                    const blockNumber = derivedBlock.block.header.number.toNumber();
                    if (!newBlocks.find(b => b.number === blockNumber)) {
                        let timestamp = Date.now();
                        derivedBlock.block.extrinsics.forEach((ex) => { if (ex.method.section === 'timestamp' && ex.method.method === 'set') timestamp = ex.method.args[0].toNumber(); });
                        let authorAddr = derivedBlock.author ? derivedBlock.author.toString() : "System";
                        newBlocks.push({ number: blockNumber, hash: derivedBlock.block.header.hash.toHex(), authorAddress: authorAddr, authorName: await getIdentity(globalApi, authorAddr), extrinsicsCount: derivedBlock.block.extrinsics.length, eventsCount: derivedBlock.events ? derivedBlock.events.length : 0, timestamp: timestamp });
                    } else break;
                    currentHash = derivedBlock.block.header.parentHash;
                } else break;
            } catch (e) { break; }
            blocksSearched++;
        }
        cacheData.blocks = newBlocks.sort((a, b) => b.number - a.number).slice(0, 200);
        cacheData.status = 'Synced';
        await fs.writeFile(BLOCKS_CACHE_FILE, JSON.stringify(cacheData));
    } catch (err) { } finally { isSyncingBlocks = false; }
}

async function syncTransactions() {
    if (isSyncingTx || !globalApi) return;
    isSyncingTx = true;
    try {
        let cacheData = { transactions: [], status: 'Syncing' };
        try { cacheData = JSON.parse(await fs.readFile(TX_CACHE_FILE, 'utf8')); } catch (e) { }
        let currentHash = await globalApi.rpc.chain.getBlockHash();
        let blocksSearched = 0;
        const newTransactions = cacheData.transactions ? [...cacheData.transactions] : [];

        while (blocksSearched < 50) {
            try {
                const signedBlock = await globalApi.rpc.chain.getBlock(currentHash);
                const blockNumber = signedBlock.block.header.number.toNumber();
                let timestamp = Date.now();
                signedBlock.block.extrinsics.forEach((ex) => { if (ex.method.section === 'timestamp' && ex.method.method === 'set') timestamp = ex.method.args[0].toNumber(); });

                signedBlock.block.extrinsics.forEach((ex) => {
                    if (ex.isSigned && !newTransactions.find(t => t.hash === ex.hash.toHex())) {
                        newTransactions.push({ hash: ex.hash.toHex(), from: ex.signer.toString(), to: ex.method.args[0] ? ex.method.args[0].toString() : "System", block: blockNumber, amount: "Tx", numericAmount: 0, value: '0$', status: 'success', timestamp: timestamp });
                    }
                });
                currentHash = signedBlock.block.header.parentHash;
            } catch (e) { break; }
            blocksSearched++;
        }
        cacheData.transactions = newTransactions.sort((a, b) => b.timestamp - a.timestamp).slice(0, 500);
        cacheData.status = 'Synced';
        await fs.writeFile(TX_CACHE_FILE, JSON.stringify(cacheData));
    } catch (err) { } finally { isSyncingTx = false; }
}

async function syncEvents() {
    if (isSyncingEvents || !globalApi) return;
    isSyncingEvents = true;
    try {
        let cacheData = { events: [], status: 'Syncing' };
        try { cacheData = JSON.parse(await fs.readFile(EVENTS_CACHE_FILE, 'utf8')); } catch (e) { }
        let currentHash = await globalApi.rpc.chain.getBlockHash();
        let blocksSearched = 0;
        const newEvents = cacheData.events ? [...cacheData.events] : [];

        while (blocksSearched < 50) {
            try {
                const signedBlock = await globalApi.rpc.chain.getBlock(currentHash);
                const blockNumber = signedBlock.block.header.number.toNumber();
                let timestamp = Date.now();
                signedBlock.block.extrinsics.forEach((ex) => { if (ex.method.section === 'timestamp' && ex.method.method === 'set') timestamp = ex.method.args[0].toNumber(); });

                for (const ex of signedBlock.block.extrinsics) {
                    if (ex.isSigned && ex.method.section !== 'balances' && ex.method.section !== 'timestamp' && !newEvents.find(e => e.hash === ex.hash.toHex())) {
                        newEvents.push({ hash: ex.hash.toHex(), block: blockNumber, section: ex.method.section, method: ex.method.method, signerAddress: ex.signer.toString(), signerName: await getIdentity(globalApi, ex.signer.toString()), timestamp: timestamp, status: 'success' });
                    }
                }
                currentHash = signedBlock.block.header.parentHash;
            } catch (e) { break; }
            blocksSearched++;
        }
        cacheData.events = newEvents.sort((a, b) => b.timestamp - a.timestamp).slice(0, 500);
        cacheData.status = 'Synced';
        await fs.writeFile(EVENTS_CACHE_FILE, JSON.stringify(cacheData));
    } catch (err) { } finally { isSyncingEvents = false; }
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

    // Sync every 5 minutes
    setInterval(() => {
        syncData();
        syncHolders();
        syncBlocks();
        syncTransactions();
        syncEvents();
    }, 5 * 60 * 1000);
}

start();