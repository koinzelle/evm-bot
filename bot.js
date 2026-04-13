const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const WALLET = process.env.WALLET;
const HYPERVM_RPC = "https://rpc.hyperliquid.xyz/evm";
const SONEIUM_RPC = "https://rpc.soneium.org";
const PRJX_NFPM = "0xeaD19AE861c29bBb2101E834922B2FEee69B9091";
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
        const result = await rpcCall(rpc, pool, "0x3850c7bd");
        return decodeTick(result.slice(66, 130));
    } catch (err) {
        console.log("Erreur tick:", err.message);
        return null;
    }
}

async function getPrjxActivePositions() {
    try {
        const walletAddr = (WALLET || "0xBc16f4Eb00559Bb28949Ac89Ff61574dA87bAE2D").toLowerCase().replace("0x", "");
        const walletPadded = walletAddr.padStart(64, "0");
        const balanceHex = await rpcCall(HYPERVM_RPC, PRJX_NFPM, "0x70a08231" + walletPadded);
        const balance = parseInt(balanceHex, 16);
        console.log("Wallet:", WALLET, "| NFT balance:", balance);
        const positions = [];
        for (let i = 0; i < balance; i++) {
            const indexHex = i.toString(16).padStart(64, "0");
            const tokenIdHex = await rpcCall(HYPERVM_RPC, PRJX_NFPM, "0x2f745c59" + walletPadded.padStart(64, "0") + indexHex);
            const tokenId = parseInt(tokenIdHex, 16);
            const tokenIdPadded = tokenId.toString(16).padStart(64, "0");
            const posData = await rpcCall(HYPERVM_RPC, PRJX_NFPM, "0x99fbab88" + tokenIdPadded);
            if (!posData || posData === "0x") continue;
            const data = posData.slice(2);
            const liquidity = BigInt("0x" + data.slice(448, 512));
            if (liquidity === 0n) { console.log("  NFT #" + tokenId + " — liquidity 0, ignoré"); continue; }
            const token0 = data.slice(128, 192).slice(24).toLowerCase();
            const token1 = data.slice(192, 256).slice(24).toLowerCase();
            const tickLower = decodeTick(data.slice(320, 384));
            const tickUpper = decodeTick(data.slice(384, 448));
            console.log("  NFT #" + tokenId + " | token0: " + token0 + " | token1: " + token1 + " | range [" + tickLower + ", " + tickUpper + "]");
            const isUbtc = token0.includes(UBTC) || token1.includes(UBTC);
            const isUpump = token0.includes(UPUMP) || token1.includes(UPUMP);
            if (!isUbtc && !isUpump) { console.log("  → ignoré (pas uBTC ni upump)"); continue; }
            const poolName = isUbtc ? "PRJX HYPE/uBTC" : "PRJX upump/HYPE";
            const pool = isUbtc ? HYPE_UBTC_POOL : UPUMP_HYPE_POOL;
            positions.push({ tokenId, tickLower, tickUpper, poolName, pool });
        }
        return positions;
    } catch (err) {
        console.log("Erreur positions PRJX:", err.message);
        return [];
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
}

setInterval(check, 30000);
check();
