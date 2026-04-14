const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const WALLET = process.env.WALLET;
const HYPERVM_RPC = "https://rpc.hyperliquid.xyz/evm";
const SONEIUM_RPC = "https://rpc.soneium.org";
const BSC_RPC = "https://bsc-dataseed.binance.org/";
const SAKE_POOL = "0x3C3987A310ee13F7B8cBBe21D97D4436ba5E4B5f";
const LISTA_INTERACTION = "0xB68443Ee3e828baD1526b3e0Bdf2Dfc6b1975ec4";
const LISTA_COLLATERALS = [
    { token: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", symbol: "BNB" },     // WBNB
    { token: "0xa2E3356610840701BDf5611a53974510Ae27E2e1", symbol: "WBETH" },
    { token: "0xB0b84D294e0C75A6abe60171b70edEb2EFd14A1B", symbol: "slisBNB" },
];
const HF_ALERT_THRESHOLD = 1.15;
const CITREA_RPC = "https://rpc.mainnet.citrea.xyz";
const PRJX_NFPM = "0xeaD19AE861c29bBb2101E834922B2FEee69B9091";
const SATSUMA_NFPM = "0x69D57B9D705eaD73a5d2f2476C30c55bD755cc2F"; // Algebra Positions NFT-V2
const SATSUMA_CBTC_CTUSD_POOL = "0x5d4b518984ae9778479ee2ea782b9925bbf17080";
const VELODROME_POOL = "0xc6b8e3559feb231d7769c12872ffbe95c3e20ff7";
const VELODROME_TICK_LOWER = 264247;
const VELODROME_TICK_UPPER = 265547;
const HYPE_UBTC_POOL = "0x0D6ECB912b6ee160e95Bc198b618Acc1bCb92525";
const UPUMP_HYPE_POOL = "0x78cc152a531dbde2f3fe7001ad659fa120fa893b";
const UBTC = "9fdbda0a5e284c32744d2f17ee5c74b284993463";
const UPUMP = "27ec642013bcb3d80ca3706599d3cda04f6f4452";

let alertedPositions = {};
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

function decodeTick(hex) {
    const max = BigInt("0x10000000000000000000000000000000000000000000000000000000000000000");
    let tick = BigInt("0x" + hex);
    if (tick >= max / 2n) tick = tick - max;
    return Number(tick);
}

async function rpcCall(rpc, to, data) {
    const res = await axios.post(rpc, {
        jsonrpc: "2.0",
        method: "eth_call",
        params: [{ to, data }, "latest"],
        id: 1
    });
    return res.data.result;
}

async function getPoolTick(rpc, pool) {
    try {
        const result = await rpcCall(rpc, pool, "0x3850c7bd"); // slot0() — Uniswap V3
        return decodeTick(result.slice(66, 130));
    } catch (err) {
        console.log("Erreur tick:", err.message);
        return null;
    }
}

async function getAlgebraPoolTick(rpc, pool) {
    try {
        const result = await rpcCall(rpc, pool, "0xe76c01e4"); // globalState() — Algebra
        return decodeTick(result.slice(66, 130));
    } catch (err) {
        console.log("Erreur tick Algebra:", err.message);
        return null;
    }
}

async function getPrjxActivePositions() {
    try {
        const walletAddr = (WALLET || "0xBc16f4Eb00559Bb28949Ac89Ff61574dA87bAE2D").toLowerCase().replace("0x", "");
        const walletPadded = walletAddr.padStart(64, "0");
        const balanceHex = await rpcCall(HYPERVM_RPC, PRJX_NFPM, "0x70a08231" + walletPadded);
        const balance = parseInt(balanceHex, 16);
        const positions = [];
        let skipped = 0;
        // Scan en partant des NFTs les plus récents (fin de liste), s'arrête après 15 vides consécutifs
        let emptyStreak = 0;
        for (let i = balance - 1; i >= 0 && emptyStreak < 15; i--) {
            const indexHex = i.toString(16).padStart(64, "0");
            const tokenIdHex = await rpcCall(HYPERVM_RPC, PRJX_NFPM, "0x2f745c59" + walletPadded + indexHex);
            const tokenId = parseInt(tokenIdHex, 16);
            const tokenIdPadded = tokenId.toString(16).padStart(64, "0");
            const posData = await rpcCall(HYPERVM_RPC, PRJX_NFPM, "0x99fbab88" + tokenIdPadded);
            if (!posData || posData === "0x") { emptyStreak++; continue; }
            const data = posData.slice(2);
            const liquidity = BigInt("0x" + data.slice(448, 512));
            if (liquidity === 0n) { emptyStreak++; skipped++; continue; }
            emptyStreak = 0;
            const token0 = data.slice(128, 192).slice(24).toLowerCase();
            const token1 = data.slice(192, 256).slice(24).toLowerCase();
            const tickLower = decodeTick(data.slice(320, 384));
            const tickUpper = decodeTick(data.slice(384, 448));
            const isUbtc = token0.includes(UBTC) || token1.includes(UBTC);
            const isUpump = token0.includes(UPUMP) || token1.includes(UPUMP);
            if (!isUbtc && !isUpump) continue;
            const poolName = isUbtc ? "PRJX HYPE/uBTC" : "PRJX upump/HYPE";
            const pool = isUbtc ? HYPE_UBTC_POOL : UPUMP_HYPE_POOL;
            positions.push({ tokenId, tickLower, tickUpper, poolName, pool });
        }
        if (skipped > 0) console.log("  (" + skipped + " NFTs inactifs ignorés)");
        return positions;
    } catch (err) {
        console.log("Erreur positions PRJX:", err.message);
        return [];
    }
}

async function getSatsumaActivePositions() {
    try {
        const walletAddr = (WALLET || "0xBc16f4Eb00559Bb28949Ac89Ff61574dA87bAE2D").toLowerCase().replace("0x", "");
        const walletPadded = walletAddr.padStart(64, "0");
        const balanceHex = await rpcCall(CITREA_RPC, SATSUMA_NFPM, "0x70a08231" + walletPadded);
        const balance = parseInt(balanceHex, 16);
        if (!balance || balance === 0) return [];
        const positions = [];
        let skipped = 0;
        let emptyStreak = 0;
        for (let i = balance - 1; i >= 0 && emptyStreak < 15; i--) {
            const indexHex = i.toString(16).padStart(64, "0");
            const tokenIdHex = await rpcCall(CITREA_RPC, SATSUMA_NFPM, "0x2f745c59" + walletPadded + indexHex);
            const tokenId = parseInt(tokenIdHex, 16);
            const tokenIdPadded = tokenId.toString(16).padStart(64, "0");
            const posData = await rpcCall(CITREA_RPC, SATSUMA_NFPM, "0x99fbab88" + tokenIdPadded);
            if (!posData || posData === "0x") { emptyStreak++; continue; }
            const data = posData.slice(2);
            const liquidity = BigInt("0x" + data.slice(448, 512));
            if (liquidity === 0n) { emptyStreak++; skipped++; continue; }
            emptyStreak = 0;
            const tickLower = decodeTick(data.slice(320, 384));
            const tickUpper = decodeTick(data.slice(384, 448));
            positions.push({ tokenId, tickLower, tickUpper, poolName: "Satsuma cBTC/ctUSD", pool: SATSUMA_CBTC_CTUSD_POOL });
        }
        if (skipped > 0) console.log("  (" + skipped + " NFTs Satsuma inactifs ignorés)");
        return positions;
    } catch (err) {
        console.log("Erreur positions Satsuma:", err.message);
        return [];
    }
}

// ── Sake Finance (Soneium) — Aave V3 fork ────────────────────
async function checkSakeLending() {
    try {
        const wallet = (WALLET || "0xBc16f4Eb00559Bb28949Ac89Ff61574dA87bAE2D").toLowerCase().replace("0x", "");
        const walletPadded = wallet.padStart(64, "0");
        const result = await rpcCall(SONEIUM_RPC, SAKE_POOL, "0xbf92857c" + walletPadded);
        if (!result || result === "0x") return;
        const hex = result.slice(2);
        const hf = Number(BigInt("0x" + hex.slice(320, 384))) / 1e18;
        const totalDebt = Number(BigInt("0x" + hex.slice(64, 128))) / 1e8;
        console.log("Sake (Soneium) | HF: " + hf.toFixed(4) + " | Debt: $" + totalDebt.toFixed(2));
        if (totalDebt < 1) return; // pas de position active
        if (hf < HF_ALERT_THRESHOLD && !alertedPositions["sake_hf"]) {
            await sendAlert("🚨 LIQUIDATION RISK!\n\nSake Finance (Soneium)\nHealth Factor: " + hf.toFixed(4) + "\nSeuil: " + HF_ALERT_THRESHOLD + "\n\nRembourse ou ajoute du collatéral !");
            alertedPositions["sake_hf"] = true;
        }
        if (hf >= HF_ALERT_THRESHOLD && alertedPositions["sake_hf"]) {
            await sendAlert("✅ Sake Finance OK\nHealth Factor: " + hf.toFixed(4));
            alertedPositions["sake_hf"] = false;
        }
    } catch (err) {
        console.log("Erreur Sake lending:", err.message);
    }
}

// ── Morpho Blue (Katana) — via API GraphQL ────────────────────
async function checkMorphoLending() {
    try {
        const wallet = (WALLET || "0xBc16f4Eb00559Bb28949Ac89Ff61574dA87bAE2D").toLowerCase();
        const query = `{ marketPositions(where: { userAddress_in: ["${wallet}"], chainId_in: [747474] }) { items { market { uniqueKey lltv collateralAsset { symbol } loanAsset { symbol } } state { collateralUsd borrowAssetsUsd } } } }`;
        const res = await axios.post("https://blue-api.morpho.org/graphql", { query }, { timeout: 10000 });
        const items = res.data?.data?.marketPositions?.items || [];
        for (const pos of items) {
            const m = pos.market || {};
            const s = pos.state || {};
            const colUsd = parseFloat(s.collateralUsd || 0);
            const borUsd = parseFloat(s.borrowAssetsUsd || 0);
            if (borUsd < 1) continue;
            const lltv = Number(BigInt(m.lltv || "0")) / 1e18;
            const hf = (colUsd * lltv) / borUsd;
            const label = (m.collateralAsset?.symbol || "?") + "/" + (m.loanAsset?.symbol || "?");
            const key = "morpho_" + m.uniqueKey?.slice(0, 10);
            console.log("Morpho " + label + " | HF: " + hf.toFixed(4) + " | Debt: $" + borUsd.toFixed(2));
            if (hf < HF_ALERT_THRESHOLD && !alertedPositions[key]) {
                await sendAlert("🚨 LIQUIDATION RISK!\n\nMorpho Blue (Katana)\nMarché: " + label + "\nHealth Factor: " + hf.toFixed(4) + "\nSeuil: " + HF_ALERT_THRESHOLD + "\n\nRembourse ou ajoute du collatéral !");
                alertedPositions[key] = true;
            }
            if (hf >= HF_ALERT_THRESHOLD && alertedPositions[key]) {
                await sendAlert("✅ Morpho " + label + " OK\nHealth Factor: " + hf.toFixed(4));
                alertedPositions[key] = false;
            }
        }
    } catch (err) {
        console.log("Erreur Morpho lending:", err.message);
    }
}

// ── Lista DAO (BSC) ───────────────────────────────────────────
async function checkListaLending() {
    try {
        const wallet = (WALLET || "0xBc16f4Eb00559Bb28949Ac89Ff61574dA87bAE2D").toLowerCase().replace("0x", "");
        const walletPadded = wallet.padStart(64, "0");
        for (const col of LISTA_COLLATERALS) {
            const tokenPadded = col.token.toLowerCase().replace("0x", "").padStart(64, "0");
            // locked(token, user) — collatéral déposé
            const lockedHex = await rpcCall(BSC_RPC, LISTA_INTERACTION, "0x804db99b" + tokenPadded + walletPadded);
            const locked = Number(BigInt(lockedHex || "0x0")) / 1e18;
            if (locked < 0.0001) continue; // pas de position sur ce collatéral
            // currentLiquidationPrice(token, user)
            const liqPriceHex = await rpcCall(BSC_RPC, LISTA_INTERACTION, "0x9e0e8b2c" + tokenPadded + walletPadded);
            const liqPrice = Number(BigInt(liqPriceHex || "0x0")) / 1e18;
            // collateralPrice(token)
            const curPriceHex = await rpcCall(BSC_RPC, LISTA_INTERACTION, "0x32d9f3db" + tokenPadded);
            const curPrice = Number(BigInt(curPriceHex || "0x0")) / 1e18;
            if (curPrice === 0 || liqPrice === 0) continue;
            const buffer = (curPrice - liqPrice) / curPrice;
            const key = "lista_" + col.symbol;
            console.log("Lista " + col.symbol + " | Prix: $" + curPrice.toFixed(4) + " | Liq: $" + liqPrice.toFixed(4) + " | Buffer: " + (buffer * 100).toFixed(1) + "%");
            if (buffer < 0.15 && !alertedPositions[key]) {
                await sendAlert("🚨 LIQUIDATION RISK!\n\nLista DAO (BSC)\nCollatéral: " + col.symbol + "\nPrix actuel: $" + curPrice.toFixed(4) + "\nPrix liquidation: $" + liqPrice.toFixed(4) + "\nBuffer: " + (buffer * 100).toFixed(1) + "% (< 15%)\n\nRembourse ou ajoute du collatéral !");
                alertedPositions[key] = true;
            }
            if (buffer >= 0.15 && alertedPositions[key]) {
                await sendAlert("✅ Lista " + col.symbol + " OK\nBuffer: " + (buffer * 100).toFixed(1) + "%");
                alertedPositions[key] = false;
            }
        }
    } catch (err) {
        console.log("Erreur Lista lending:", err.message);
    }
}

async function sendAlert(msg) {
    try {
        await bot.sendMessage(CHAT_ID, msg);
        console.log("✅ Telegram envoyé");
    } catch (err) {
        console.log("❌ Telegram ERREUR:", err.message);
    }
}

async function check() {
    console.log("\n--- Verification ---");
    const veloTick = await getPoolTick(SONEIUM_RPC, VELODROME_POOL);
    if (veloTick !== null) {
        const inRange = veloTick >= VELODROME_TICK_LOWER && veloTick <= VELODROME_TICK_UPPER;
        console.log("Velodrome WBTC/WETH | Tick: " + veloTick + " | " + (inRange ? "IN RANGE" : "OUT OF RANGE"));
        if (!inRange && !alertedPositions["velodrome"]) {
            const side = veloTick < VELODROME_TICK_LOWER ? "100% WBTC" : "100% WETH";
            await sendAlert("🚨 OUT OF RANGE!\n\nVelodrome WBTC/WETH\nTick: " + veloTick + "\nTu es: " + side + "\n\nAjuste ta position!");
            alertedPositions["velodrome"] = true;
        }
        if (inRange && alertedPositions["velodrome"]) {
            await sendAlert("✅ Retour IN RANGE\n\nVelodrome WBTC/WETH\nTick: " + veloTick);
            alertedPositions["velodrome"] = false;
        }
    }
    const positions = await getPrjxActivePositions();
    console.log("PRJX: " + positions.length + " positions actives");
    for (const pos of positions) {
        const tick = await getPoolTick(HYPERVM_RPC, pos.pool);
        if (tick === null) continue;
        const inRange = tick >= pos.tickLower && tick <= pos.tickUpper;
        console.log(pos.poolName + " #" + pos.tokenId + " | Tick: " + tick + " | Range: [" + pos.tickLower + ", " + pos.tickUpper + "] | " + (inRange ? "IN RANGE" : "OUT OF RANGE"));
        const key = "prjx_" + pos.tokenId;
        if (!inRange && !alertedPositions[key]) {
            const side = tick < pos.tickLower ? "100% HYPE" : "100% uBTC/upump";
            await sendAlert("🚨 OUT OF RANGE!\n\n" + pos.poolName + " #" + pos.tokenId + "\nTick: " + tick + "\nRange: [" + pos.tickLower + ", " + pos.tickUpper + "]\nTu es: " + side + "\n\nAjuste ta position!");
            alertedPositions[key] = true;
        }
        if (inRange && alertedPositions[key]) {
            await sendAlert("✅ Retour IN RANGE\n\n" + pos.poolName + " #" + pos.tokenId + "\nTick: " + tick);
            alertedPositions[key] = false;
        }
    }

    // ── Satsuma (Citrea) ──────────────────────────────────────
    const satsumaPositions = await getSatsumaActivePositions();
    console.log("Satsuma: " + satsumaPositions.length + " positions actives");
    for (const pos of satsumaPositions) {
        const tick = await getAlgebraPoolTick(CITREA_RPC, pos.pool);
        if (tick === null) continue;
        const inRange = tick >= pos.tickLower && tick <= pos.tickUpper;
        console.log(pos.poolName + " #" + pos.tokenId + " | Tick: " + tick + " | Range: [" + pos.tickLower + ", " + pos.tickUpper + "] | " + (inRange ? "IN RANGE" : "OUT OF RANGE"));
        const key = "satsuma_" + pos.tokenId;
        if (!inRange && !alertedPositions[key]) {
            const side = tick < pos.tickLower ? "100% cBTC" : "100% ctUSD";
            await sendAlert("🚨 OUT OF RANGE!\n\nSatsuma cBTC/ctUSD #" + pos.tokenId + "\nTick: " + tick + "\nRange: [" + pos.tickLower + ", " + pos.tickUpper + "]\nTu es: " + side + "\n\nAjuste ta position!");
            alertedPositions[key] = true;
        }
        if (inRange && alertedPositions[key]) {
            await sendAlert("✅ Retour IN RANGE\n\nSatsuma cBTC/ctUSD #" + pos.tokenId + "\nTick: " + tick);
            alertedPositions[key] = false;
        }
    }

    // ── Lending / Borrowing ───────────────────────────────────
    await checkSakeLending();
    await checkMorphoLending();
    await checkListaLending();
}

setInterval(check, 30000);
check();
