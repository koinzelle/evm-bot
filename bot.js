const axios = require("axios");

const TELEGRAM_TOKEN = (process.env.TELEGRAM_TOKEN || '').trim().replace(/^[^0-9]+/, '');
const CHAT_ID        = (process.env.CHAT_ID || '').trim();
const WALLET = (process.env.WALLET || "0xBc16f4Eb00559Bb28949Ac89Ff61574dA87bAE2D").toLowerCase();
const WALLET_NO_PREFIX = WALLET.replace("0x", "").padStart(64, "0");

const HYPERVM_RPC = "https://rpc.hyperliquid.xyz/evm";
const SONEIUM_RPC = "https://rpc.soneium.org";
const BSC_RPC     = "https://bsc-dataseed.binance.org/";
const CITREA_RPC  = "https://rpc.mainnet.citrea.xyz";

const SAKE_POOL           = "0x3C3987A310ee13F7B8cBBe21D97D4436ba5E4B5f";
const LISTA_MOOLAH        = "0x8f73b65b4caaf64fba2af91cc5d4a2a1318e5d8c";
const LISTA_MARKET_ID     = "95f93825819b67a64610e6adb9ac5f70d5108f5121b9df6551e23a4a7a801b5b";
const LISTA_ORACLE        = "0xF07b74724cC734079D9D1aa22fF7591B5A32D9d2";
const LISTA_LLTV          = 860000000000000000n;
const HF_ALERT_THRESHOLD  = 1.15;

const PRJX_NFPM           = "0xeaD19AE861c29bBb2101E834922B2FEee69B9091";
const SATSUMA_NFPM        = "0x69D57B9D705eaD73a5d2f2476C30c55bD755cc2F";
const SATSUMA_IGNORED_IDS = new Set([3231]); // positions dust/vides à ignorer
const SATSUMA_CBTC_CTUSD_POOL = "0x5d4b518984ae9778479ee2ea782b9925bbf17080";
const VELODROME_NFPM      = "0x991d5546c4b442b4c5fdc4c8b8b8d131deb24702";
const VELODROME_POOL      = "0xc6b8e3559feb231d7769c12872ffbe95c3e20ff7";
const HYPE_UBTC_POOL      = "0x0D6ECB912b6ee160e95Bc198b618Acc1bCb92525";
const UPUMP_HYPE_POOL     = "0x78cc152a531dbde2f3fe7001ad659fa120fa893b";
const UBTC  = "9fdbda0a5e284c32744d2f17ee5c74b284993463";
const UPUMP = "27ec642013bcb3d80ca3706599d3cda04f6f4452";

const OOR_COOLDOWN        = 10 * 60 * 1000; // rappel hors range toutes les 10 min
const CHECK_INTERVAL      = 60 * 1000;      // cycle toutes les 60s

let alertedPositions = {};
// Telegram via axios direct (même approche que le bot Meteora)

// ── Utilitaires ───────────────────────────────────────────────

function decodeTick(hex) {
    const max = BigInt("0x10000000000000000000000000000000000000000000000000000000000000000");
    let tick = BigInt("0x" + hex);
    if (tick >= max / 2n) tick = tick - max;
    return Number(tick);
}

async function rpcCall(rpc, to, data) {
    const res = await axios.post(rpc, {
        jsonrpc: "2.0", method: "eth_call",
        params: [{ to, data }, "latest"], id: 1
    }, { timeout: 10000 });
    return res.data.result;
}

async function getPoolTick(rpc, pool) {
    try {
        const result = await rpcCall(rpc, pool, "0x3850c7bd"); // slot0() — Uniswap V3
        return decodeTick(result.slice(66, 130));
    } catch (err) {
        console.log("Erreur tick " + pool.slice(0, 8) + ":", err.message);
        return null;
    }
}

async function getAlgebraPoolTick(rpc, pool) {
    try {
        const result = await rpcCall(rpc, pool, "0xe76c01e4"); // globalState() — Algebra
        if (result && result !== "0x" && result.length >= 130) return decodeTick(result.slice(66, 130));
    } catch (_) {}
    try {
        const result = await rpcCall(rpc, pool, "0x3850c7bd"); // slot0() fallback
        if (result && result !== "0x" && result.length >= 130) return decodeTick(result.slice(66, 130));
    } catch (err) {
        console.log("Algebra tick échoué:", err.message);
    }
    return null;
}

async function sendAlert(msg) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                chat_id: CHAT_ID,
                text: msg,
            }, { timeout: 10000 });
            console.log("✅ Telegram envoyé");
            return true;
        } catch (err) {
            const detail = err.response?.data?.description || err.message;
            console.log("❌ Telegram ERREUR (tentative " + attempt + "/3):", detail);
            if (attempt < 3) await new Promise(r => setTimeout(r, 5000));
        }
    }
    return false;
}

function checkOorAlert(key, inRange, alertMsg, returnMsg) {
    // Retourne une Promise qui gère l'alerte hors-range avec cooldown 10 min
    if (!inRange && (!alertedPositions[key] || Date.now() - alertedPositions[key] > OOR_COOLDOWN)) {
        return sendAlert(alertMsg).then(ok => { if (ok) alertedPositions[key] = Date.now(); });
    }
    if (inRange && alertedPositions[key]) {
        alertedPositions[key] = 0;
        return sendAlert(returnMsg);
    }
    return Promise.resolve();
}

// ── Positions Velodrome (Soneium) ─────────────────────────────

async function getVelodromeActivePositions() {
    try {
        const balanceHex = await rpcCall(SONEIUM_RPC, VELODROME_NFPM, "0x70a08231" + WALLET_NO_PREFIX);
        const balance = parseInt(balanceHex, 16);
        if (!balance || balance === 0) return [];
        const positions = [];
        let skipped = 0, emptyStreak = 0;
        for (let i = balance - 1; i >= 0 && emptyStreak < 15; i--) {
            const indexHex = i.toString(16).padStart(64, "0");
            const tokenIdHex = await rpcCall(SONEIUM_RPC, VELODROME_NFPM, "0x2f745c59" + WALLET_NO_PREFIX + indexHex);
            const tokenId = parseInt(tokenIdHex, 16);
            const posData = await rpcCall(SONEIUM_RPC, VELODROME_NFPM, "0x99fbab88" + tokenId.toString(16).padStart(64, "0"));
            if (!posData || posData === "0x") { emptyStreak++; continue; }
            const data = posData.slice(2);
            const tickLower = decodeTick(data.slice(320, 384));
            const tickUpper = decodeTick(data.slice(384, 448));
            const liquidity = BigInt("0x" + data.slice(448, 512));
            if (liquidity === 0n) { emptyStreak++; skipped++; continue; }
            emptyStreak = 0;
            positions.push({ tokenId, tickLower, tickUpper, poolName: "Velodrome WBTC/WETH", pool: VELODROME_POOL });
        }
        if (skipped > 0) console.log("  (" + skipped + " NFTs Velodrome inactifs ignorés)");
        return positions;
    } catch (err) {
        console.log("Erreur positions Velodrome:", err.message);
        return [];
    }
}

// ── Positions PRJX (Hyperliquid) ──────────────────────────────

async function getPrjxActivePositions() {
    try {
        const balanceHex = await rpcCall(HYPERVM_RPC, PRJX_NFPM, "0x70a08231" + WALLET_NO_PREFIX);
        const balance = parseInt(balanceHex, 16);
        const positions = [];
        let skipped = 0, emptyStreak = 0;
        for (let i = balance - 1; i >= 0 && emptyStreak < 15; i--) {
            const indexHex = i.toString(16).padStart(64, "0");
            const tokenIdHex = await rpcCall(HYPERVM_RPC, PRJX_NFPM, "0x2f745c59" + WALLET_NO_PREFIX + indexHex);
            const tokenId = parseInt(tokenIdHex, 16);
            const posData = await rpcCall(HYPERVM_RPC, PRJX_NFPM, "0x99fbab88" + tokenId.toString(16).padStart(64, "0"));
            if (!posData || posData === "0x") { emptyStreak++; continue; }
            const data = posData.slice(2);
            const liquidity = BigInt("0x" + data.slice(448, 512));
            if (liquidity === 0n) { emptyStreak++; skipped++; continue; }
            emptyStreak = 0;
            const token0 = data.slice(128, 192).slice(24).toLowerCase();
            const token1 = data.slice(192, 256).slice(24).toLowerCase();
            const isUbtc  = token0.includes(UBTC)  || token1.includes(UBTC);
            const isUpump = token0.includes(UPUMP) || token1.includes(UPUMP);
            if (!isUbtc && !isUpump) continue;
            positions.push({
                tokenId,
                tickLower: decodeTick(data.slice(320, 384)),
                tickUpper: decodeTick(data.slice(384, 448)),
                poolName: isUbtc ? "PRJX HYPE/uBTC" : "PRJX upump/HYPE",
                pool: isUbtc ? HYPE_UBTC_POOL : UPUMP_HYPE_POOL,
            });
        }
        if (skipped > 0) console.log("  (" + skipped + " NFTs inactifs ignorés)");
        return positions;
    } catch (err) {
        console.log("Erreur positions PRJX:", err.message);
        return [];
    }
}

// ── Positions Satsuma (Citrea) ────────────────────────────────

async function getSatsumaActivePositions() {
    try {
        const balanceHex = await rpcCall(CITREA_RPC, SATSUMA_NFPM, "0x70a08231" + WALLET_NO_PREFIX);
        const balance = parseInt(balanceHex, 16);
        if (!balance || balance === 0) return [];
        const positions = [];
        let skipped = 0, emptyStreak = 0;
        for (let i = balance - 1; i >= 0 && emptyStreak < 15; i--) {
            const indexHex = i.toString(16).padStart(64, "0");
            const tokenIdHex = await rpcCall(CITREA_RPC, SATSUMA_NFPM, "0x2f745c59" + WALLET_NO_PREFIX + indexHex);
            const tokenId = parseInt(tokenIdHex, 16);
            if (SATSUMA_IGNORED_IDS.has(tokenId)) { skipped++; continue; }
            const posData = await rpcCall(CITREA_RPC, SATSUMA_NFPM, "0x99fbab88" + tokenId.toString(16).padStart(64, "0"));
            if (!posData || posData === "0x") { emptyStreak++; continue; }
            const data = posData.slice(2);
            // Détection format : Algebra V2 (sans fee) vs Uniswap V3 (avec fee en word 4)
            const tlA = decodeTick(data.slice(256, 320));
            const tuA = decodeTick(data.slice(320, 384));
            let tickLower, tickUpper, liquidity;
            if (tlA < tuA) {
                tickLower = tlA; tickUpper = tuA;
                liquidity = BigInt("0x" + data.slice(384, 448));
            } else {
                tickLower = decodeTick(data.slice(320, 384));
                tickUpper = decodeTick(data.slice(384, 448));
                liquidity = BigInt("0x" + data.slice(448, 512));
            }
            if (liquidity === 0n) { emptyStreak++; skipped++; continue; }
            emptyStreak = 0;
            positions.push({ tokenId, tickLower, tickUpper, poolName: "Satsuma cBTC/ctUSD", pool: SATSUMA_CBTC_CTUSD_POOL });
        }
        if (skipped > 0) console.log("  (" + skipped + " NFTs Satsuma inactifs ignorés)");
        return positions;
    } catch (err) {
        console.log("Erreur positions Satsuma:", err.message);
        return [];
    }
}

// ── Lending ───────────────────────────────────────────────────

async function checkSakeLending() {
    try {
        const result = await rpcCall(SONEIUM_RPC, SAKE_POOL, "0xbf92857c" + WALLET_NO_PREFIX);
        if (!result || result === "0x") return;
        const hex = result.slice(2);
        const hf = Number(BigInt("0x" + hex.slice(320, 384))) / 1e18;
        const totalDebt = Number(BigInt("0x" + hex.slice(64, 128))) / 1e8;
        console.log("Sake (Soneium) | HF: " + hf.toFixed(4) + " | Debt: $" + totalDebt.toFixed(2));
        if (totalDebt < 1) return;
        const key = "sake_hf";
        if (hf < HF_ALERT_THRESHOLD && !alertedPositions[key]) {
            if (await sendAlert("🚨 LIQUIDATION RISK!\n\nSake Finance (Soneium)\nHealth Factor: " + hf.toFixed(4) + "\nSeuil: " + HF_ALERT_THRESHOLD + "\n\nRembourse ou ajoute du collatéral !"))
                alertedPositions[key] = true;
        }
        if (hf >= HF_ALERT_THRESHOLD && alertedPositions[key]) {
            await sendAlert("✅ Sake Finance OK\nHealth Factor: " + hf.toFixed(4));
            alertedPositions[key] = false;
        }
    } catch (err) { console.log("Erreur Sake:", err.message); }
}

async function checkMorphoLending() {
    try {
        const wallet = WALLET;
        const query = `{ marketPositions(where: { userAddress_in: ["${wallet}"], chainId_in: [747474] }) { items { market { uniqueKey lltv collateralAsset { symbol } loanAsset { symbol } } state { collateralUsd borrowAssetsUsd } } } }`;
        const res = await axios.post("https://blue-api.morpho.org/graphql", { query }, { timeout: 10000 });
        const items = res.data?.data?.marketPositions?.items || [];
        for (const pos of items) {
            const m = pos.market || {}, s = pos.state || {};
            const colUsd = parseFloat(s.collateralUsd || 0);
            const borUsd = parseFloat(s.borrowAssetsUsd || 0);
            if (borUsd < 1) continue;
            const hf = (colUsd * Number(BigInt(m.lltv || "0")) / 1e18) / borUsd;
            const label = (m.collateralAsset?.symbol || "?") + "/" + (m.loanAsset?.symbol || "?");
            const key = "morpho_" + m.uniqueKey?.slice(0, 10);
            console.log("Morpho " + label + " | HF: " + hf.toFixed(4) + " | Debt: $" + borUsd.toFixed(2));
            if (hf < HF_ALERT_THRESHOLD && !alertedPositions[key]) {
                if (await sendAlert("🚨 LIQUIDATION RISK!\n\nMorpho Blue (Katana)\nMarché: " + label + "\nHealth Factor: " + hf.toFixed(4) + "\nSeuil: " + HF_ALERT_THRESHOLD + "\n\nRembourse ou ajoute du collatéral !"))
                    alertedPositions[key] = true;
            }
            if (hf >= HF_ALERT_THRESHOLD && alertedPositions[key]) {
                await sendAlert("✅ Morpho " + label + " OK\nHealth Factor: " + hf.toFixed(4));
                alertedPositions[key] = false;
            }
        }
    } catch (err) { console.log("Erreur Morpho:", err.message); }
}

async function checkListaLending() {
    try {
        // 3 appels indépendants → en parallèle
        const [posHex, mktHex, priceHex] = await Promise.all([
            rpcCall(BSC_RPC, LISTA_MOOLAH, "0x93c52062" + LISTA_MARKET_ID + "000000000000000000000000" + WALLET.replace("0x", "")),
            rpcCall(BSC_RPC, LISTA_MOOLAH, "0x5c60e39a" + LISTA_MARKET_ID),
            rpcCall(BSC_RPC, LISTA_ORACLE,  "0x5e9a523c"),
        ]);
        if (!posHex || posHex === "0x") { console.log("Lista Moolah | Pas de données"); return; }
        const pd = posHex.slice(2);
        const borrowShares = BigInt("0x" + pd.slice(64, 128));
        if (borrowShares === 0n) { console.log("Lista Moolah slisBNB/USD1 | Aucune dette"); return; }
        const collateral = BigInt("0x" + pd.slice(128, 192));
        const md = mktHex.slice(2);
        const totalBorrowAssets = BigInt("0x" + md.slice(128, 192));
        const totalBorrowShares = BigInt("0x" + md.slice(192, 256));
        const price = BigInt("0x" + priceHex.slice(2));
        const borrowAssets = totalBorrowShares > 0n ? (borrowShares * totalBorrowAssets) / totalBorrowShares : 0n;
        if (borrowAssets === 0n) { console.log("Lista Moolah | borrowAssets = 0"); return; }
        const hf = Number((collateral * price * LISTA_LLTV * 10000n) / (borrowAssets * (10n ** 36n) * (10n ** 18n))) / 10000;
        const borUsd = Number(borrowAssets) / 1e18;
        console.log("Lista Moolah slisBNB/USD1 | HF: " + hf.toFixed(4) + " | Debt: $" + borUsd.toFixed(2));
        const key = "lista_slisBNB_USD1";
        if (hf < HF_ALERT_THRESHOLD && !alertedPositions[key]) {
            if (await sendAlert("🚨 LIQUIDATION RISK!\n\nLista DAO Moolah (BSC)\nMarché: slisBNB/USD1\nHealth Factor: " + hf.toFixed(4) + "\nSeuil: " + HF_ALERT_THRESHOLD + "\n\nRembourse ou ajoute du collatéral !"))
                alertedPositions[key] = true;
        }
        if (hf >= HF_ALERT_THRESHOLD && alertedPositions[key]) {
            await sendAlert("✅ Lista Moolah slisBNB/USD1 OK\nHealth Factor: " + hf.toFixed(4));
            alertedPositions[key] = false;
        }
    } catch (err) { console.log("Erreur Lista:", err.message); }
}

// ── Alerte proximité de range (10% de la borne) ───────────────

async function checkNearRange(poolName, tick, tickLower, tickUpper, key) {
    if (tick < tickLower || tick > tickUpper) return;
    const rangeWidth = tickUpper - tickLower;
    const alertZone  = rangeWidth * 0.10;
    const COOLDOWN   = 10 * 60 * 1000;
    const now        = Date.now();
    const pctToLower = ((tick - tickLower) / rangeWidth * 100).toFixed(1);
    const pctToUpper = ((tickUpper - tick)  / rangeWidth * 100).toFixed(1);
    const keyLower   = key + "_near_lower";
    const keyUpper   = key + "_near_upper";
    if (tick < tickLower + alertZone) {
        if (!alertedPositions[keyLower] || now - alertedPositions[keyLower] > COOLDOWN) {
            const ok = await sendAlert("⚠️ PROCHE SORTIE DE RANGE — côté BAS\n\n" + poolName + "\nTick actuel : " + tick + "\nBorne basse  : " + tickLower + "\nIl reste " + pctToLower + "% avant sortie\n\nLe prix est en train de baisser — surveille ta position !");
            if (ok) alertedPositions[keyLower] = now;
        }
    } else { alertedPositions[keyLower] = 0; }
    if (tick > tickUpper - alertZone) {
        if (!alertedPositions[keyUpper] || now - alertedPositions[keyUpper] > COOLDOWN) {
            const ok = await sendAlert("⚠️ PROCHE SORTIE DE RANGE — côté HAUT\n\n" + poolName + "\nTick actuel : " + tick + "\nBorne haute  : " + tickUpper + "\nIl reste " + pctToUpper + "% avant sortie\n\nLe prix est en train de monter — surveille ta position !");
            if (ok) alertedPositions[keyUpper] = now;
        }
    } else { alertedPositions[keyUpper] = 0; }
}

// ── Vérification LP positions ─────────────────────────────────

async function checkLpPosition(poolName, tick, tickLower, tickUpper, key, rpc) {
    if (tick === null) {
        console.log("⚠️ " + poolName + " | Impossible de lire le tick (RPC KO)");
        return;
    }
    const inRange = tick >= tickLower && tick <= tickUpper;
    console.log(poolName + " | Tick: " + tick + " | Range: [" + tickLower + ", " + tickUpper + "] | " + (inRange ? "IN RANGE" : "⚠️ OUT OF RANGE"));
    const side = tick < tickLower ? "côté BAS" : "côté HAUT";
    await checkOorAlert(
        key, inRange,
        "🚨 OUT OF RANGE!\n\n" + poolName + "\nTick: " + tick + "\nRange: [" + tickLower + ", " + tickUpper + "]\nTu es: " + side + "\n\nAjuste ta position!",
        "✅ Retour IN RANGE\n\n" + poolName + "\nTick: " + tick
    );
    await checkNearRange(poolName, tick, tickLower, tickUpper, key);
}

// ── Boucle principale ─────────────────────────────────────────

async function check() {
    console.log("\n--- Verification ---");

    // Étape 1 : fetch positions en parallèle
    const [velodromePositions, prjxPositions, satsumaPositions] = await Promise.all([
        getVelodromeActivePositions(),
        getPrjxActivePositions(),
        getSatsumaActivePositions(),
    ]);

    // Étape 2 : fetch ticks LP + lending en parallèle
    const veloTick = velodromePositions.length > 0 ? await getPoolTick(SONEIUM_RPC, VELODROME_POOL) : null;
    const prjxTickPromises = prjxPositions.map(pos => getPoolTick(HYPERVM_RPC, pos.pool));
    const satsumaTickPromises = satsumaPositions.map(pos => getAlgebraPoolTick(CITREA_RPC, pos.pool));

    const [prjxTicks, satsumaTicks] = await Promise.all([
        Promise.all(prjxTickPromises),
        Promise.all(satsumaTickPromises),
    ]);

    // Étape 3 : alertes LP
    console.log("Velodrome: " + velodromePositions.length + " positions actives");
    for (const pos of velodromePositions) {
        console.log("Velodrome WBTC/WETH #" + pos.tokenId + " | Tick: " + veloTick + " | Range: [" + pos.tickLower + ", " + pos.tickUpper + "] | " + (veloTick !== null ? (veloTick >= pos.tickLower && veloTick <= pos.tickUpper ? "IN RANGE" : "⚠️ OUT OF RANGE") : "❌ RPC KO"));
        await checkLpPosition(pos.poolName + " #" + pos.tokenId + " (Soneium)", veloTick, pos.tickLower, pos.tickUpper, "velodrome_" + pos.tokenId);
    }

    console.log("PRJX: " + prjxPositions.length + " positions actives");
    for (let i = 0; i < prjxPositions.length; i++) {
        const pos = prjxPositions[i];
        await checkLpPosition(pos.poolName + " #" + pos.tokenId + " (Hyperliquid)", prjxTicks[i], pos.tickLower, pos.tickUpper, "prjx_" + pos.tokenId);
    }

    console.log("Satsuma: " + satsumaPositions.length + " positions actives");
    for (let i = 0; i < satsumaPositions.length; i++) {
        const pos = satsumaPositions[i];
        await checkLpPosition(pos.poolName + " #" + pos.tokenId + " (Citrea)", satsumaTicks[i], pos.tickLower, pos.tickUpper, "satsuma_" + pos.tokenId);
    }

    // Étape 4 : lending en parallèle
    await Promise.all([checkSakeLending(), checkMorphoLending(), checkListaLending()]);
}

let isChecking = false;
async function safeCheck() {
    if (isChecking) { console.log("⏳ Vérification précédente en cours, skip"); return; }
    isChecking = true;
    try { await check(); } finally { isChecking = false; }
}
console.log("🤖 EVM Bot démarré");
console.log("📱 Telegram token longueur:", TELEGRAM_TOKEN.length, "| CHAT_ID:", CHAT_ID);
setInterval(safeCheck, CHECK_INTERVAL);
safeCheck();
