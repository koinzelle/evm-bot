const axios = require("axios");
const fs = require("fs");
const path = require("path");
const http = require("http");

// ── Capture des logs pour /logs (sur Railway console.log part dans le flux Railway, pas de fichier) ──
const LOG_BUFFER = [];
const _origLog = console.log.bind(console), _origErr = console.error.bind(console);
function _cap(fn, args) {
    try {
        LOG_BUFFER.push(`[${new Date().toISOString()}] ` + args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" "));
        if (LOG_BUFFER.length > 3000) LOG_BUFFER.shift();
    } catch (_) {}
    fn(...args);
}
console.log = (...a) => _cap(_origLog, a);
console.error = (...a) => _cap(_origErr, a);

// État de la dernière vérif → exposé sur /status
let lastStatus = { updatedAt: null, lp: [], lending: [] };

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

const PRJX_NFPM           = "0xeaD19AE861c29bBb2101E834922B2FEee69B9091";
const SATSUMA_NFPM        = "0x69D57B9D705eaD73a5d2f2476C30c55bD755cc2F";
const SATSUMA_IGNORED_IDS = new Set([3231]); // positions dust/vides à ignorer
const SATSUMA_CBTC_CTUSD_POOL = "0x5d4b518984ae9778479ee2ea782b9925bbf17080";
const VELODROME_NFPM      = "0x991d5546c4b442b4c5fdc4c8b8b8d131deb24702";
const VELODROME_GAUGE     = "0x9659d8C3371bBEA56e083F4e497c0b5097519509";
const VELODROME_POOL      = "0xc6b8e3559feb231d7769c12872ffbe95c3e20ff7";
const HYPE_UBTC_POOL      = "0x0D6ECB912b6ee160e95Bc198b618Acc1bCb92525";
const UPUMP_HYPE_POOL     = "0x78cc152a531dbde2f3fe7001ad659fa120fa893b";
const KHYPE_UBTC_POOL     = "0x467364bd2a633208b4534f5b7ec11d24604546e4"; // PRJX 0.3% fee
const UBTC  = "9fdbda0a5e284c32744d2f17ee5c74b284993463";
const UPUMP = "27ec642013bcb3d80ca3706599d3cda04f6f4452";
const KHYPE = "fd739d4e423301ce9385c1fb8850539d657c296d"; // Kinetiq Staked HYPE

const OOR_COOLDOWN        = 60 * 60 * 1000; // rappel hors range toutes les heures
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

// ── Positions Velodrome (Soneium) — lecture via Blockscout + NFPM ─────────────

async function getVelodromeActivePositions() {
    try {
        // Trouver les tokenIds stakés : NFT transférés wallet→gauge et pas encore retirés
        const res = await axios.get("https://soneium.blockscout.com/api", {
            params: { module: "account", action: "tokennfttx", contractaddress: VELODROME_NFPM, address: WALLET, page: 1, offset: 50 },
            timeout: 10000,
        });
        const txs = res.data?.result || [];
        const walletL = WALLET.toLowerCase(), gaugeL = VELODROME_GAUGE.toLowerCase();
        const staked = new Set(), unstaked = new Set();
        for (const tx of txs) {
            const tid = parseInt(tx.tokenID);
            if (isNaN(tid)) continue;
            if (tx.from?.toLowerCase() === walletL && tx.to?.toLowerCase() === gaugeL) staked.add(tid);
            if (tx.from?.toLowerCase() === gaugeL  && tx.to?.toLowerCase() === walletL) unstaked.add(tid);
        }
        const activeIds = [...staked].filter(id => !unstaked.has(id));

        const positions = [];
        for (const tokenId of activeIds) {
            const posData = await rpcCall(SONEIUM_RPC, VELODROME_NFPM, "0x99fbab88" + tokenId.toString(16).padStart(64, "0"));
            if (!posData || posData === "0x") continue;
            const data = posData.slice(2);
            const tickLower  = decodeTick(data.slice(320, 384));
            const tickUpper  = decodeTick(data.slice(384, 448));
            const liquidity  = BigInt("0x" + data.slice(448, 512));
            if (liquidity === 0n) continue;
            positions.push({ tokenId, tickLower, tickUpper, poolName: "Velodrome WBTC/WETH", pool: VELODROME_POOL });
        }
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
            const hasUbtc  = token0.includes(UBTC)  || token1.includes(UBTC);
            const hasUpump = token0.includes(UPUMP) || token1.includes(UPUMP);
            const hasKhype = token0.includes(KHYPE) || token1.includes(KHYPE);
            // Distinguer KHYPE/UBTC vs HYPE/UBTC : si KHYPE est présent avec UBTC, c'est la pool kHYPE
            const isKhypeUbtc = hasKhype && hasUbtc;
            const isHypeUbtc = hasUbtc && !hasKhype; // UBTC sans KHYPE = pool HYPE classique
            const isUpump = hasUpump;
            if (!isKhypeUbtc && !isHypeUbtc && !isUpump) continue;
            let poolName, pool;
            if (isKhypeUbtc) { poolName = "PRJX kHYPE/uBTC"; pool = KHYPE_UBTC_POOL; }
            else if (isHypeUbtc) { poolName = "PRJX HYPE/uBTC"; pool = HYPE_UBTC_POOL; }
            else { poolName = "PRJX upump/HYPE"; pool = UPUMP_HYPE_POOL; }
            positions.push({
                tokenId,
                tickLower: decodeTick(data.slice(320, 384)),
                tickUpper: decodeTick(data.slice(384, 448)),
                poolName,
                pool,
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
// Paliers HF progressifs (même logique que near-range) : 1 notif par palier franchi à la
// baisse (1.15 → 1.10 → 1.05), rappel 1×/heure max au palier critique (< 1.05), reset +
// message "risque écarté" quand le HF repasse ≥ 1.15.

const HF_LEVELS      = [1.15, 1.10, 1.05];
const HF_REMINDER_MS = 60 * 60 * 1000;

function hfUrgence(level) {
    return level === 1.05 ? "🔴 CRITIQUE" : level === 1.10 ? "🟠 TRÈS ÉLEVÉE" : "🟡 ÉLEVÉE";
}

async function checkHfAlert(key, hf, alertMsgFn, recoveryMsg) {
    const now = Date.now();
    const st = alertedPositions[key];
    if (hf >= HF_LEVELS[0]) {
        if (st) { delete alertedPositions[key]; await sendAlert(recoveryMsg); }
        return;
    }
    const level = Math.min(...HF_LEVELS.filter(L => hf < L)); // palier le plus profond franchi
    if (!st || typeof st !== "object" || level < st.level) {
        if (await sendAlert(alertMsgFn(level, false))) alertedPositions[key] = { level, lastAt: now };
    } else if (st.level === HF_LEVELS[HF_LEVELS.length - 1] && now - st.lastAt > HF_REMINDER_MS) {
        if (await sendAlert(alertMsgFn(level, true))) st.lastAt = now;
    }
}

async function checkSakeLending() {
    try {
        const result = await rpcCall(SONEIUM_RPC, SAKE_POOL, "0xbf92857c" + WALLET_NO_PREFIX);
        if (!result || result === "0x") return;
        const hex = result.slice(2);
        const hf = Number(BigInt("0x" + hex.slice(320, 384))) / 1e18;
        const totalDebt = Number(BigInt("0x" + hex.slice(64, 128))) / 1e8;
        console.log("Sake (Soneium) | HF: " + hf.toFixed(4) + " | Debt: $" + totalDebt.toFixed(2));
        if (totalDebt < 1) return;
        lastStatus.lending.push({ name: "Sake (Soneium)", hf: Number(hf.toFixed(4)), debt: Number(totalDebt.toFixed(2)) });
        await checkHfAlert("sake_hf", hf,
            (level, rappel) => `${rappel ? "⏰ RAPPEL — " : ""}🚨 LIQUIDATION RISK — Sake Finance (Soneium)\n\n❤️ Health Factor : ${hf.toFixed(4)} (palier < ${level})\n💸 Dette         : $${totalDebt.toFixed(2)}\n⚡ Urgence       : ${hfUrgence(level)}\n\nRembourse ou ajoute du collatéral immédiatement !`,
            `✅ Sake Finance — Risque écarté (Soneium)\n\n❤️ Health Factor : ${hf.toFixed(4)}\n💸 Dette         : $${totalDebt.toFixed(2)}`);
    } catch (err) { console.log("Erreur Sake:", err.message); }
}

async function checkMorphoLending() {
    try {
        const wallet = WALLET;
        // Base (8453) + Katana (747474) — chainId multiple pour ne pas être aveugle si les positions bougent de chaîne
        const query = `{ marketPositions(where: { userAddress_in: ["${wallet}"], chainId_in: [8453, 747474] }) { items { market { marketId lltv chain { network } collateralAsset { symbol } loanAsset { symbol } } state { collateralUsd borrowAssetsUsd } } } }`;
        const res = await axios.post("https://blue-api.morpho.org/graphql", { query }, { timeout: 10000 });
        const items = res.data?.data?.marketPositions?.items || [];
        for (const pos of items) {
            const m = pos.market || {}, s = pos.state || {};
            const colUsd = parseFloat(s.collateralUsd || 0);
            const borUsd = parseFloat(s.borrowAssetsUsd || 0);
            if (borUsd < 1) continue;
            const hf = (colUsd * Number(BigInt(m.lltv || "0")) / 1e18) / borUsd;
            const label = (m.collateralAsset?.symbol || "?") + "/" + (m.loanAsset?.symbol || "?");
            const chainName = m.chain?.network || "?";
            const key = "morpho_" + m.marketId?.slice(0, 10);
            console.log("Morpho " + label + " (" + chainName + ") | HF: " + hf.toFixed(4) + " | Debt: $" + borUsd.toFixed(2));
            lastStatus.lending.push({ name: "Morpho " + label + " (" + chainName + ")", hf: Number(hf.toFixed(4)), debt: Number(borUsd.toFixed(2)) });
            await checkHfAlert(key, hf,
                (level, rappel) => `${rappel ? "⏰ RAPPEL — " : ""}🚨 LIQUIDATION RISK — Morpho Blue (${chainName})\n\n📊 Marché        : ${label}\n❤️ Health Factor : ${hf.toFixed(4)} (palier < ${level})\n💸 Dette         : $${borUsd.toFixed(2)}\n💎 Collatéral    : $${colUsd.toFixed(2)}\n⚡ Urgence       : ${hfUrgence(level)}\n\nRembourse ou ajoute du collatéral immédiatement !`,
                `✅ Morpho ${label} — Risque écarté (${chainName})\n\n❤️ Health Factor : ${hf.toFixed(4)}\n💸 Dette         : $${borUsd.toFixed(2)}`);
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
        lastStatus.lending.push({ name: "Lista slisBNB/USD1 (BSC)", hf: Number(hf.toFixed(4)), debt: Number(borUsd.toFixed(2)) });
        await checkHfAlert("lista_slisBNB_USD1", hf,
            (level, rappel) => `${rappel ? "⏰ RAPPEL — " : ""}🚨 LIQUIDATION RISK — Lista DAO Moolah (BSC)\n\n📊 Marché        : slisBNB/USD1\n❤️ Health Factor : ${hf.toFixed(4)} (palier < ${level})\n💸 Dette         : $${borUsd.toFixed(2)}\n⚡ Urgence       : ${hfUrgence(level)}\n\nRembourse ou ajoute du collatéral immédiatement !`,
            `✅ Lista Moolah slisBNB/USD1 — Risque écarté (BSC)\n\n❤️ Health Factor : ${hf.toFixed(4)}\n💸 Dette         : $${borUsd.toFixed(2)}`);
    } catch (err) { console.log("Erreur Lista:", err.message); }
}

// ── Alerte proximité de range — paliers 20% → 15% → 10% → 5%, puis rappel horaire ──
// 1 notif par palier franchi (si le prix saute direct de 25% à 8%, une seule notif "palier 10%").
// Une fois au palier 10% : 1 rappel par heure max tant qu'on y reste. Reset quand on repasse > 20%.

const NEAR_LEVELS      = [20, 15, 10, 5];   // % de range restant avant la borne
const NEAR_REMINDER_MS = 60 * 60 * 1000;    // rappel horaire après le dernier palier

async function checkNearSide(poolName, tick, bound, boundLabel, pctLeft, ticksLeft, trendMsg, key) {
    const now = Date.now();
    const st = alertedPositions[key];
    if (pctLeft > NEAR_LEVELS[0]) { if (st) delete alertedPositions[key]; return; }
    const level = Math.min(...NEAR_LEVELS.filter(L => pctLeft <= L)); // palier le plus profond atteint
    if (!st || typeof st !== "object" || level < st.level) {
        // nouveau palier franchi → notif immédiate
        const ok = await sendAlert(`⚠️ PROCHE ${boundLabel} (palier ${level}%) — ${poolName}\n\n📍 Tick actuel : ${tick}\n📏 Borne       : ${bound}\n📊 Reste       : ${pctLeft.toFixed(1)}% (${ticksLeft} ticks)\n\n${trendMsg}`);
        if (ok) alertedPositions[key] = { level, lastAt: now };
    } else if (now - st.lastAt > NEAR_REMINDER_MS) {
        // toujours dans une zone d'alerte (n'importe quel palier 20/15/10/5) depuis > 1h → rappel horaire
        // avec l'état actuel. AVANT : ne rappelait qu'au palier 5% → une position collée à 8-12% restait
        // muette après la 1re alerte (bug : LP kHYPE/uBTC à 8.9% jamais rappelée).
        const ok = await sendAlert(`⏰ RAPPEL (palier ${st.level}%) — ${poolName} toujours proche ${boundLabel.toLowerCase()}\n\n📍 Tick actuel : ${tick}\n📏 Borne       : ${bound}\n📊 Reste       : ${pctLeft.toFixed(1)}% (${ticksLeft} ticks)\n\n${trendMsg}`);
        if (ok) st.lastAt = now;
    }
}

async function checkNearRange(poolName, tick, tickLower, tickUpper, key) {
    if (tick < tickLower || tick > tickUpper) return;
    const rangeWidth = tickUpper - tickLower;
    const pctToLower = (tick - tickLower) / rangeWidth * 100;
    const pctToUpper = (tickUpper - tick)  / rangeWidth * 100;
    await checkNearSide(poolName, tick, tickLower, "BORNE BASSE", pctToLower, tick - tickLower, "Le prix baisse — surveille ta position !", key + "_near_lower");
    await checkNearSide(poolName, tick, tickUpper, "BORNE HAUTE", pctToUpper, tickUpper - tick, "Le prix monte — surveille ta position !", key + "_near_upper");
}

// ── Vérification LP positions ─────────────────────────────────

async function checkLpPosition(poolName, tick, tickLower, tickUpper, key, rpc) {
    if (tick === null) {
        console.log("⚠️ " + poolName + " | Impossible de lire le tick (RPC KO)");
        return;
    }
    const inRange = tick >= tickLower && tick <= tickUpper;
    const rangeWidth = tickUpper - tickLower;
    const pctInRange = inRange ? ((tick - tickLower) / rangeWidth * 100).toFixed(1) : null;
    // distance à la borne la plus proche (%) — pour /status
    const nearestPct = inRange ? Math.min((tick - tickLower) / rangeWidth * 100, (tickUpper - tick) / rangeWidth * 100) : 0;
    lastStatus.lp.push({ pool: poolName, tick, range: [tickLower, tickUpper], inRange, pctInRange: pctInRange ? Number(pctInRange) : null, distBornePct: Number(nearestPct.toFixed(1)) });
    console.log(poolName + " | Tick: " + tick + " | Range: [" + tickLower + ", " + tickUpper + "] | " + (inRange ? `IN RANGE (${pctInRange}%)` : "⚠️ OUT OF RANGE"));
    const side = tick < tickLower ? "BAS" : "HAUT";
    const dist = tick < tickLower ? tickLower - tick : tick - tickUpper;
    await checkOorAlert(
        key, inRange,
        `🚨 OUT OF RANGE — ${poolName}\n\n📍 Tick actuel : ${tick}\n📏 Range       : [${tickLower}, ${tickUpper}]\n↕️ Côté        : ${side} (${dist} ticks hors range)\n\nAjuste ou retire ta position !`,
        `✅ Retour IN RANGE — ${poolName}\n\n📍 Tick actuel : ${tick}\n📏 Range       : [${tickLower}, ${tickUpper}]\n📊 Position    : ${pctInRange ?? '?'}% dans le range`
    );
    await checkNearRange(poolName, tick, tickLower, tickUpper, key);
}

// ── Boucle principale ─────────────────────────────────────────

async function check() {
    console.log("\n--- Verification ---");
    lastStatus = { updatedAt: new Date().toISOString(), lp: [], lending: [] };

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

// ── Serveur HTTP : /status (état live des LP + lending) et /logs (buffer) ──────
// Rend le domaine Railway joignable (sinon 502 — worker sans port) + visibilité distante.
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    if (url === "/logs") {
        const tail = parseInt(new URL(req.url, "http://x").searchParams.get("tail") || "300", 10);
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(LOG_BUFFER.slice(-tail).join("\n"));
    } else if (url === "/status") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(lastStatus, null, 2));
    } else {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("EVM alert bot OK\nEndpoints: /status  /logs?tail=N");
    }
}).listen(PORT, () => console.log("🌐 HTTP server on port " + PORT));

// Rotation bot.log toutes les heures — garde les 5000 dernières lignes si > 2MB
setInterval(() => {
    const logPath = path.join(__dirname, 'bot.log');
    try {
        if (!fs.existsSync(logPath)) return;
        const stats = fs.statSync(logPath);
        if (stats.size < 2 * 1024 * 1024) return;
        const lines = fs.readFileSync(logPath, 'utf8').split('\n');
        fs.writeFileSync(logPath, lines.slice(-5000).join('\n'));
        console.log(`🗂️ bot.log tronqué — ${lines.length} → 5000 lignes`);
    } catch (e) { /* silencieux */ }
}, 60 * 60 * 1000);
