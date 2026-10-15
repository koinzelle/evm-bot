'use strict';
// ── ANALYSE DE RENTABILITÉ DES STRATÉGIES LP (2026-10-15, demande user) ────────────────────────────
// Ce qu'il voulait : « une synthèse globale de la position sur ce LP, pas juste des infos sur celle en
// cours ». Chaque fois qu'il ferme et rouvre, c'est un nouveau NFT : on regroupe donc TOUTES ses positions
// sur une même pool (ouvertes et fermées) en une STRATÉGIE, et on en fait le bilan : PnL, frais ou
// récompenses, gas, effet LP (frais − divergence) et effet marché, comparaison au HOLD et au fait de garder
// 100 % de chaque jeton, plus un verdict avec l'action conseillée (garder / élargir / changer de paire).
// LECTURE SEULE : aucune transaction, aucune clé privée. Un plantage ici ne doit JAMAIS couper les alertes
// du bot : `tick()` ne bloque pas la boucle et tout est sous try/catch.
// Rythme voulu : mesure SILENCIEUSE toutes les 15 min, UNE synthèse Telegram par jour.
// Calcul validé le 15/10 contre l'outil tiers sur PRJX UPUMP/WHYPE #562889 : valeur, fourchette, largeur
// 20,92 %, frais 0,262 $, divergence −0,125 $, vs HOLD +0,137 $, rétention 52,3 %, gas 0,0055 $ identiques.
// Seul écart : le PnL, qui dépend du prix d'entrée du HYPE (bougie Hyperliquid de la minute du dépôt).
//
// D'où viennent les positions :
//   • ouvertes : les listes que le bot lit déjà pour ses alertes (aucun appel en plus) ;
//   • fermées : l'explorateur de la chaîne — Blockscout pour Ink et Soneium (gratuit, sans clé),
//     Etherscan v2 pour HyperEVM (clé gratuite ETHERSCAN_API_KEY). Sans clé, HyperEVM ne couvre que les
//     positions vues par le bot à partir de maintenant (le nœud public n'a pas d'historique exploitable).
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');

const MESURE_MS         = 15 * 60 * 1000;
const HEURE_SYNTHESE    = Number(process.env.SYNTHESE_LP_HEURE || 9);   // heure de Paris
const AGE_VERDICT_H     = 24;     // pas de verdict avant 24 h : sur quelques heures, le bruit domine
const DANS_MIN_PCT      = 70;     // sous 70 % du temps dans la fourchette → élargir
const ECART_STRATEGIE_J = 7;      // plus de 7 jours sans position sur une pool → la suivante repart de zéro
const DECOUVERTE_MS     = 60 * 60 * 1000;   // relecture des NFT du wallet chez l'explorateur
const DECOUVERTE_JOURS  = 60;               // positions passées : 60 derniers jours (Soneium en compte des dizaines)
const DECOUVERTE_LOT    = 8;                // positions créées par passage : une chaîne lente ne bloque pas les autres
const RAFRAICHIR_MS     = 30 * 60 * 1000;   // relecture des événements des positions ouvertes (explorateur)
// Sans explorateur (HyperEVM sans clé), on lit les événements en RPC par fenêtres de 1 000 blocs (plafond
// du nœud public, mesuré le 15/10), UNE fenêtre par minute : plus vite, le nœud renvoie « rate limited » à
// toute l'IP, y compris aux lectures de tick des alertes hors range (vu en test le 15/10).
const SCAN_FENETRE      = 1000;
const SCAN_MAX_BLOCS    = 3 * 86400;        // ≈ 3 jours à 1 bloc/s ; au-delà, base = première vue

const T_INC       = '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f';   // IncreaseLiquidity
const T_DEC       = '0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4';   // DecreaseLiquidity
const T_COL       = '0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01';   // Collect
const T_TRANSFER  = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const T_CLAIM     = '0x1f89f96333d3133000ee447473151fa9606543368f02271c9d95ae14f13bcc67';   // ClaimRewards (gauge Velodrome)
const T_MINT_POOL = '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde';   // Mint de la pool (fourchette)
const ZERO32      = '0x' + '0'.repeat(64);
const ZERO_ADR    = '0x' + '0'.repeat(40);

// Prix de référence : Hyperliquid pour HYPE/ETH/BTC (gratuit, bougies historiques), 1 $ pour les stables ;
// l'autre jeton de la paire est valorisé par le prix de la pool elle-même.
const STABLES = new Set(['USDC', 'USDT', 'USDT0', 'USD₮0', 'USDE', 'USDC.E', 'CTUSD', 'USD1', 'LISUSD', 'DAI', 'USDS', 'FDUSD', 'USDH']);
const ANCRES  = { WHYPE: 'HYPE', HYPE: 'HYPE', WETH: 'ETH', ETH: 'ETH', KBTC: 'BTC', UBTC: 'BTC', WBTC: 'BTC', CBBTC: 'BTC', CIRBTC: 'BTC', BTC: 'BTC',
    SOL: 'SOL', WSOL: 'SOL' };

let C = null;                                              // config injectée par bot.js
let E = { positions: {}, tokens: {}, pools: {}, derniereSynthese: null, decouverte: {} };   // état persistant
const calculs = {};                                        // clé → dernière mesure en direct d'une position ouverte
let listes = {};                                           // dernières listes de positions ouvertes reçues du bot
let derniereMesure = 0, mesureEnCours = false, fondEnCours = false;

const pad      = x => BigInt(x).toString(16).padStart(64, '0');
const padAdr   = a => a.toLowerCase().replace('0x', '').padStart(64, '0');
const attendre = ms => new Promise(r => setTimeout(r, ms));
function s256(w) { const v = BigInt('0x' + w.replace('0x', '')); return Number(v >= (1n << 255n) ? v - (1n << 256n) : v); }
const fr    = (x, d = 2) => (x == null || !isFinite(x)) ? '—' : x.toFixed(d).replace('.', ',');
const signe = (x, d = 2) => (x == null || !isFinite(x)) ? '—' : (x >= 0 ? '+' : '−') + fr(Math.abs(x), d);
const duree = h => h == null ? '—' : h < 48 ? `${fr(h, 0)} h` : `${fr(h / 24, 1)} j`;
const log   = m => console.log('  📐 ' + m);

// ── Persistance (volume Railway) ──────────────────────────────────────────────────────────────
function fichier() { return path.join(C.dataDir, 'analyse-lp.json'); }
function charger() {
    try { E = JSON.parse(fs.readFileSync(fichier(), 'utf8')); } catch (_) { /* premier démarrage */ }
    for (const k of ['positions', 'tokens', 'pools', 'prochaineDecouverte', 'ignores']) E[k] = E[k] || {};
}
function sauver() {
    try { const f = fichier(); fs.writeFileSync(f + '.tmp', JSON.stringify(E)); fs.renameSync(f + '.tmp', f); }
    catch (e) { log('sauvegarde impossible — ' + e.message); }
}

// ── Accès réseau : une file par chaîne (RPC), une file par service (explorateur, Hyperliquid) ─────
const _files = {};
function enFile(nom, gapMs, fn) {
    const p = (_files[nom] || Promise.resolve()).then(async () => { try { return await fn(); } finally { await attendre(gapMs); } });
    _files[nom] = p.catch(() => {});
    return p;
}
function rpc(ch, method, params) {
    const conf = C.chaines[ch];
    return enFile('rpc:' + ch, conf.pauseMs || 250, async () => {
        for (let essai = 0; essai < 4; essai++) {
            let r;
            try { r = await axios.post(conf.rpc, { jsonrpc: '2.0', id: 1, method, params }, { timeout: 20000 }); }
            catch (e) { if (essai === 3) throw e; await attendre(3000 * (essai + 1)); continue; }
            if (r.data && r.data.error) {
                const m = String(r.data.error.message || '');
                if (/rate.?limit|too many requests/i.test(m)) { await attendre(15000 * (essai + 1)); continue; }
                const err = new Error(m); err.revert = true; throw err;      // revert / paramètre refusé
            }
            return r.data.result;
        }
        throw new Error('RPC saturé (' + ch + ')');
    });
}
const appel = (ch, to, data, from) => rpc(ch, 'eth_call', [from ? { to, data, from } : { to, data }, 'latest']);

function explorateur(ch) {
    const conf = C.chaines[ch];
    if (conf.blockscout) return { url: conf.blockscout, extra: {} };
    if (conf.etherscanChainId && process.env.ETHERSCAN_API_KEY)
        return { url: 'https://api.etherscan.io/v2/api', extra: { chainid: conf.etherscanChainId, apikey: process.env.ETHERSCAN_API_KEY } };
    return null;
}
function explGet(ch, params) {
    const X = explorateur(ch);
    // Etherscan gratuit = 5 appels/s ; Blockscout public est plus strict (429 en rafale vu le 15/10 sur Soneium)
    return enFile('expl:' + X.url, C.chaines[ch].explPauseMs || (C.chaines[ch].blockscout ? 1500 : 350), async () => {
        for (let essai = 0; essai < 3; essai++) {
            try {
                const r = await axios.get(X.url, { timeout: 20000, params: { ...X.extra, ...params } });
                const res = r.data?.result;
                if (Array.isArray(res)) return res;
                if (/no (records|transactions|logs) found/i.test(String(r.data?.message || '') + String(res || ''))) return [];
                if (/rate limit|max rate/i.test(String(res || ''))) { await attendre(2000 * (essai + 1)); continue; }
                throw new Error('explorateur : ' + String(res || r.data?.message || 'réponse inattendue').slice(0, 80));
            } catch (e) { if (essai === 2) throw e; await attendre(5000 * 2 ** essai); }   // 429 : 5 s, 10 s
        }
        return [];
    });
}

async function infoToken(ch, adr) {
    const k = ch + ':' + adr.toLowerCase();
    if (E.tokens[k]) return E.tokens[k];
    const dec = parseInt(await appel(ch, adr, '0x313ce567'), 16);   // decimals()
    let sym = adr.slice(0, 6);
    try {
        const r = await appel(ch, adr, '0x95d89b41');                // symbol()
        if (r && r.length > 130) sym = Buffer.from(r.slice(130), 'hex').toString('utf8').replace(/\0/g, '').trim() || sym;
    } catch (_) { /* on garde le préfixe d'adresse */ }
    return (E.tokens[k] = { adr: adr.toLowerCase(), dec, sym });
}
async function jetonsPool(ch, pool) {
    const k = ch + ':' + pool;
    if (E.pools[k]) return E.pools[k];
    const t0 = '0x' + (await appel(ch, pool, '0x0dfe1681')).slice(-40), t1 = '0x' + (await appel(ch, pool, '0xd21220a7')).slice(-40);
    return (E.pools[k] = { t0: t0.toLowerCase(), t1: t1.toLowerCase() });
}

// ── Prix ──────────────────────────────────────────────────────────────────────────────────────
let _mids = { t: 0, v: null };
async function prixAncres() {
    if (_mids.v && Date.now() - _mids.t < 5 * 60e3) return _mids.v;
    const r = await enFile('hl', 300, () => axios.post('https://api.hyperliquid.xyz/info', { type: 'allMids' }, { timeout: 10000 }));
    _mids = { t: Date.now(), v: { HYPE: +r.data.HYPE, ETH: +r.data.ETH, BTC: +r.data.BTC, SOL: +r.data.SOL } };
    return _mids.v;
}
// Hyperliquid ne garde que les 5 000 dernières bougies par intervalle : 1 min ≈ 3,5 jours, 15 min ≈ 52 jours,
// 1 h ≈ 208 jours. On prend la plus fine qui couvre la date demandée.
const _bougies = new Map();
async function prixAncreA(coin, tMs) {
    const age = Date.now() - tMs;
    const [iv, ms] = age < 3 * 86400e3 ? ['1m', 60e3] : age < 50 * 86400e3 ? ['15m', 900e3] : age < 200 * 86400e3 ? ['1h', 3600e3] : ['1d', 86400e3];
    const k = coin + iv + Math.floor(tMs / ms);
    if (_bougies.has(k)) return _bougies.get(k);
    const r = await enFile('hl', 300, () => axios.post('https://api.hyperliquid.xyz/info',
        { type: 'candleSnapshot', req: { coin, interval: iv, startTime: tMs - 3 * ms, endTime: tMs + ms } }, { timeout: 10000 }));
    const L = r.data || [];
    const c = L.filter(x => x.t <= tMs).pop() || L[0];
    const v = c ? +c.c : null;
    _bougies.set(k, v);
    return v;
}
function ancre(sym) { const s = (sym || '').toUpperCase(); return STABLES.has(s) ? 'USD' : (ANCRES[s] || null); }
const _ds = new Map();
async function prixDexScreener(ch, adr) {                // prix actuel d'un jeton sans ancre (cache 10 min)
    const k = ch + adr;
    const c = _ds.get(k);
    if (c && Date.now() - c.t < 10 * 60e3) return c.v;
    let v = null;
    try {
        const r = await axios.get(`https://api.dexscreener.com/tokens/v1/${C.chaines[ch].dexscreener}/${adr}`, { timeout: 10000 });
        const L = (r.data || []).filter(p => (p.baseToken?.address || '').toLowerCase() === adr.toLowerCase());
        L.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
        if (L[0]) v = +L[0].priceUsd;
    } catch (_) {}
    _ds.set(k, { t: Date.now(), v });
    return v;
}
// Prix historique d'un jeton sans référence : bougie horaire GeckoTerminal de la pool (gratuit, 30 appels/min).
// Sert quand un retrait ne contient qu'UN jeton (position fermée hors fourchette) : le prix de la pool ne se
// déduit plus des montants. Erreur corrigée le 15/10 : on reprenait le prix de l'ouverture, ce qui surévaluait
// le jeton retiré (divergence positive sur Velodrome #1765893, fermée sous sa fourchette).
const _gecko = new Map();
async function prixGeckoA(ch, pool, adr, tMs) {
    const net = C.chaines[ch].gecko;
    if (!net || !pool) return null;
    const heure = Math.floor(tMs / 3600e3), k = pool + adr + heure;
    if (_gecko.has(k)) return _gecko.get(k);
    let v = null;
    try {
        const r = await enFile('gecko', 2500, () => axios.get(`https://api.geckoterminal.com/api/v2/networks/${net}/pools/${pool}/ohlcv/hour`,
            { timeout: 15000, params: { token: adr, limit: 3, before_timestamp: (heure + 2) * 3600, currency: 'usd' } }));
        const L = (r.data?.data?.attributes?.ohlcv_list || []).sort((a, b) => a[0] - b[0]);
        const c = L.filter(x => x[0] * 1000 <= tMs).pop() || L[0];
        if (c) v = +c[4];
    } catch (_) {}
    _gecko.set(k, v);
    return v;
}
// prix USD [token0, token1] ; tMs = null → maintenant ; prix0en1 = prix de la pool (token1 par token0), ou null
async function prixPaire(ch, t0, t1, prix0en1, tMs, pool) {
    const a0 = ancre(t0.sym), a1 = ancre(t1.sym);
    const px = async a => a === 'USD' ? 1 : (tMs ? await prixAncreA(a, tMs) : (await prixAncres())[a]);
    if (a0 && a1) return [await px(a0), await px(a1)];                 // deux jetons de référence : chacun son prix
    if (a1) {
        const p1 = await px(a1);
        let p0 = prix0en1 != null && p1 != null ? prix0en1 * p1 : null;
        if (p0 == null && tMs) p0 = await prixGeckoA(ch, pool, t0.adr, tMs);
        return [p0, p1];
    }
    if (a0) {
        const p0 = await px(a0);
        let p1 = prix0en1 && p0 != null ? p0 / prix0en1 : null;
        if (p1 == null && tMs) p1 = await prixGeckoA(ch, pool, t1.adr, tMs);
        return [p0, p1];
    }
    if (tMs) return [await prixGeckoA(ch, pool, t0.adr, tMs), await prixGeckoA(ch, pool, t1.adr, tMs)];
    const p1 = await prixDexScreener(ch, t1.adr);
    return [p1 && prix0en1 ? prix0en1 * p1 : null, p1];
}

// ── Mathématiques Uniswap v3 / Slipstream ─────────────────────────────────────────────────────
const sqrtTick = t => Math.pow(1.0001, t / 2);
function montants(L, sp, tl, tu) {                       // montants bruts (unités entières) pour une liquidité L
    const sa = sqrtTick(tl), sb = sqrtTick(tu), l = Number(L);
    if (sp <= sa) return [l * (sb - sa) / (sa * sb), 0];
    if (sp >= sb) return [0, l * (sb - sa)];
    return [l * (sb - sp) / (sp * sb), l * (sp - sa)];
}
function decoderPosition(hex) {
    const d = hex.slice(2), w = i => d.slice(i * 64, (i + 1) * 64);
    return { token0: '0x' + w(2).slice(24), token1: '0x' + w(3).slice(24), tickLower: s256(w(5)), tickUpper: s256(w(6)),
        liquidity: BigInt('0x' + w(7)) };
}

// ── Événements d'une position (dépôts, retraits, collectes) ───────────────────────────────────
function decoderLog(l) {
    const d = l.data.slice(2), w = i => BigInt('0x' + d.slice(i * 64, (i + 1) * 64));
    const type = l.topics[0] === T_INC ? 'inc' : l.topics[0] === T_DEC ? 'dec' : 'col';
    const e = { type, blk: parseInt(l.blockNumber, 16), tx: l.transactionHash, li: parseInt(l.logIndex || '0x0', 16),
        t: l.timeStamp ? parseInt(l.timeStamp, 16) : null,
        liq: type === 'col' ? null : w(0).toString(), r0: w(1).toString(), r1: w(2).toString() };
    // l'explorateur donne le gas de la transaction avec le log : pas besoin du reçu
    if (l.gasUsed && l.gasPrice) e.gasNatif = Number(BigInt(l.gasUsed) * BigInt(l.gasPrice)) / 1e18;
    return e;
}
function fusionner(P, logs) {
    let n = 0;
    for (const l of logs) {
        if (![T_INC, T_DEC, T_COL].includes(l.topics[0])) continue;
        const e = decoderLog(l);
        if (P.ev.some(x => x.tx === e.tx && x.li === e.li)) continue;
        P.ev.push(e); n++;
    }
    P.ev.sort((a, b) => a.blk - b.blk || a.li - b.li);
    return n;
}
// horodatage, prix au moment de l'événement, gas de sa transaction (une fois par transaction)
async function enrichir(P) {
    const ch = P.ch, conf = C.chaines[ch];
    const t0 = E.tokens[ch + ':' + P.t0], t1 = E.tokens[ch + ':' + P.t1];
    if (!t0 || !t1) return;
    const gasVus = new Set(P.ev.filter(e => e.gasCompte).map(e => e.tx));
    for (const e of P.ev) {
        if (e.p1 !== undefined) continue;
        if (!e.t) e.t = parseInt((await rpc(ch, 'eth_getBlockByNumber', ['0x' + e.blk.toString(16), false])).timestamp, 16);
        e.a0 = Number(e.r0) / 10 ** t0.dec; e.a1 = Number(e.r1) / 10 ** t1.dec;
        // prix de la pool à l'instant du dépôt/retrait, déduit des montants : a1 = ΔL·(√P − √Pa)
        let prix0en1 = null;
        if (e.liq && e.liq !== '0' && e.r0 !== '0' && e.r1 !== '0') {
            const sp = Number(e.r1) / Number(e.liq) + sqrtTick(P.tl);
            prix0en1 = sp * sp * 10 ** (t0.dec - t1.dec);
            e.prix0en1 = prix0en1;
        }
        // même transaction qu'un dépôt/retrait des deux côtés (collecte d'une fermeture, réinvestissement) : même prix
        if (prix0en1 == null) { const v = P.ev.find(x => x.tx === e.tx && x.prix0en1 != null); if (v) prix0en1 = v.prix0en1; }
        [e.p0, e.p1] = await prixPaire(ch, t0, t1, prix0en1, e.t * 1000, P.pool);
        if (e.p0 == null || e.p1 == null) {                           // dernier recours : prix d'un événement voisin
            const v = P.ev.filter(x => x.prix0en1 != null).sort((a, b) => Math.abs(a.blk - e.blk) - Math.abs(b.blk - e.blk))[0];
            if (v) { [e.p0, e.p1] = await prixPaire(ch, t0, t1, v.prix0en1, e.t * 1000, P.pool); e.prixApprox = true; }
        }
        if (!gasVus.has(e.tx)) {
            gasVus.add(e.tx); e.gasCompte = true;
            let natif = e.gasNatif;
            if (natif == null) {
                try {
                    const rc = await rpc(ch, 'eth_getTransactionReceipt', [e.tx]);
                    natif = Number(BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice || '0x0') + BigInt(rc.l1Fee || '0x0')) / 1e18;
                } catch (_) { natif = 0; }
            }
            const pn = natif ? await prixAncreA(conf.natif, e.t * 1000) : 0;
            e.gasUsd = pn ? natif * pn : 0;
        }
    }
    // une position sans liquidité restante est fermée : date = dernier retrait
    const liq = P.ev.reduce((a, e) => a + (e.type === 'inc' ? BigInt(e.liq) : e.type === 'dec' ? -BigInt(e.liq) : 0n), 0n);
    const decs = P.ev.filter(e => e.type === 'dec');
    if (liq <= 0n && decs.length && P.source === 'explorateur') P.fermeeA = P.fermeeA || decs[decs.length - 1].t * 1000;
}

// ── Découverte des positions passées (explorateur) ────────────────────────────────────────────
async function logsPosition(ch, id) {
    return explGet(ch, { module: 'logs', action: 'getLogs', fromBlock: 0, toBlock: 'latest',
        address: C.chaines[ch].nfpm, topic1: '0x' + pad(id) });
}
// fourchette et pool lues dans l'événement Mint émis par la pool lors du dépôt d'ouverture (marche même
// pour un NFT brûlé, dont `positions()` ne répond plus)
async function creerDepuisChaine(ch, id) {
    const P = { ch, id: String(id), ev: [], source: 'explorateur', suivi: { dansMs: 0, totalMs: 0, dernier: null, dernierDans: null } };
    fusionner(P, await logsPosition(ch, id));
    const inc = P.ev.find(e => e.type === 'inc');
    if (!inc) return null;                                    // NFT sans dépôt
    const rc = await rpc(ch, 'eth_getTransactionReceipt', [inc.tx]);
    const nfpm = C.chaines[ch].nfpm.toLowerCase();
    const m = rc.logs.find(l => l.topics[0] === T_MINT_POOL && l.topics[1] === '0x' + padAdr(nfpm)
        && BigInt('0x' + l.data.slice(66, 130)) === BigInt(inc.liq));
    if (!m) return null;
    P.pool = m.address.toLowerCase(); P.tl = s256(m.topics[2]); P.tu = s256(m.topics[3]);
    const { t0, t1 } = await jetonsPool(ch, P.pool);
    await infoToken(ch, t0); await infoToken(ch, t1);
    P.t0 = t0; P.t1 = t1;
    P.premiereVue = Date.now();
    // stakée chez un gauge ? (positions Velodrome) — le dernier transfert du NFT part du wallet vers le gauge
    return P;
}
// par lots : au premier refus de l'explorateur on s'arrête et on reprend 10 min plus tard
async function decouvrir(ch) {
    if (!explorateur(ch)) return;
    E.prochaineDecouverte = E.prochaineDecouverte || {}; E.ignores = E.ignores || {};
    const txs = await explGet(ch, { module: 'account', action: 'tokennfttx', contractaddress: C.chaines[ch].nfpm,
        address: C.wallet, page: 1, offset: 1000, sort: 'asc' });
    const depuis = Date.now() / 1000 - DECOUVERTE_JOURS * 86400;
    const ids = [...new Set(txs.filter(t => (t.from || '').toLowerCase() === ZERO_ADR && (t.to || '').toLowerCase() === C.wallet
        && Number(t.timeStamp) >= depuis).map(t => String(t.tokenID)))];
    let n = 0, reste = 0;
    for (const id of ids) {
        const k = `${ch}:${id}`;
        if (E.positions[k] || E.ignores[k]) continue;
        if (n >= DECOUVERTE_LOT) { reste++; continue; }
        try {
            const P = await creerDepuisChaine(ch, id);
            if (!P) { E.ignores[k] = true; continue; }        // NFT sans dépôt ou sans Mint lisible : on ne réessaie pas
            // gauge : un transfert du wallet vers un contrat qui n'est pas l'adresse zéro = stake
            const stake = txs.find(t => String(t.tokenID) === String(id) && (t.from || '').toLowerCase() === C.wallet
                && (t.to || '').toLowerCase() !== ZERO_ADR);
            // seulement si ce contrat est un vrai gauge (rewardToken() répond) : sur HyperEVM, les NFT partent vers
            // l'automate de rééquilibrage du user, pas vers un gauge — vu le 16/10 (« Récompenses » affiché à tort)
            if (stake) { try { await appel(ch, stake.to, '0xf7c618c1'); P.gauge = stake.to.toLowerCase(); } catch (_) {} }
            P.gaugeVerifie = true;
            E.positions[k] = P; n++;
            await enrichir(P); P.pret = true;
            if (P.gauge && P.fermeeA) { await reclamationsSansJeton(P); }
            sauver();
        } catch (e) {
            log(`${ch} : découverte interrompue (${e.message}) — reprise dans 10 min`);
            E.prochaineDecouverte[ch] = Date.now() + 10 * 60e3;
            return;
        }
    }
    E.prochaineDecouverte[ch] = Date.now() + (reste ? 2 * 60e3 : DECOUVERTE_MS);
    if (n) log(`${ch} : ${n} position(s) passée(s) ajoutée(s) à l'historique${reste ? ` (${reste} restante(s), suite dans 2 min)` : ''}`);
}
// relit les événements (explorateur) d'une position : collectes, réinvestissements, fermeture
async function rafraichir(P) {
    const n = fusionner(P, await logsPosition(P.ch, P.id));
    if (n) { await enrichir(P); log(`${P.ch}:${P.id} : ${n} nouvel(s) événement(s)`); }
    if (P.gauge && P.fermeeA) await reclamationsSansJeton(P);
    P.rafraichiA = Date.now(); P.pret = true;
}

// ── Sans explorateur : remontée RPC (ouverture) puis suivi vers l'avant ───────────────────────
async function scanRpc(P) {
    const ch = P.ch, S = P.scan = P.scan || {};
    const tete = parseInt(await rpc(ch, 'eth_blockNumber', []), 16);
    if (S.haut == null) { S.haut = tete; S.curseur = tete; }
    let de, a, arriere = false;
    if (!S.ouvertureTrouvee) { a = S.curseur; de = Math.max(0, a - SCAN_FENETRE + 1); arriere = true; }
    else if (S.haut < tete) { de = S.haut + 1; a = Math.min(tete, S.haut + SCAN_FENETRE); }
    else return;
    const L = await rpc(ch, 'eth_getLogs', [{ address: C.chaines[ch].nfpm, fromBlock: '0x' + de.toString(16), toBlock: '0x' + a.toString(16),
        topics: [[T_INC, T_DEC, T_COL], '0x' + pad(P.id)] }]);
    const n = fusionner(P, L);
    if (arriere) {
        S.curseur = de - 1;
        for (const e of P.ev.filter(x => x.type === 'inc' && x.mint == null)) {
            const rc = await rpc(ch, 'eth_getTransactionReceipt', [e.tx]);
            e.mint = rc.logs.some(x => x.address.toLowerCase() === C.chaines[ch].nfpm.toLowerCase() && x.topics[0] === T_TRANSFER
                && x.topics[1] === ZERO32 && x.topics[3] === '0x' + pad(P.id));
            if (e.mint) S.ouvertureTrouvee = true;
        }
        if (!S.ouvertureTrouvee && (S.haut - S.curseur > SCAN_MAX_BLOCS || de === 0)) { S.abandon = true; S.ouvertureTrouvee = true; }
        if (S.ouvertureTrouvee) log(`${ch}:${P.id} : ${S.abandon ? 'ouverture introuvable (base = première vue)' : 'historique retrouvé'}`);
    } else S.haut = a;
    if (S.ouvertureTrouvee && (n || !P.pret)) { await enrichir(P); P.pret = !S.abandon; }
}

// ── RAYDIUM CLMM (Solana) — ajouté le 16/10 (demande user) ────────────────────────────────────
// Pas de « collect » simulable comme sur EVM : les frais en attente se RECALCULENT à partir des compteurs de la
// pool (croissance globale des frais) et des deux bornes de la fourchette (comptes « tick array »), comme le
// fait l'interface Raydium. Validé le 16/10 sur KOx/USDC : bornes lues = −2040 et 0, frais 2,46 $, valeur 400 $.
// Historique : chaque opération Raydium inscrit un événement dans sa transaction (« Program data », Anchor) —
// ouverture (dépôt), ajout, retrait (capital ET frais séparés) ; formats vérifiés sur les 2 transactions de la
// position (ouverture 20/09, encaissement des frais 07/10). On remonte les transactions du wallet sur 60 jours.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(buf) {
    let n = BigInt('0x' + (Buffer.from(buf).toString('hex') || '0')), s = '';
    while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
    for (const b of buf) { if (b) break; s = '1' + s; }
    return s;
}
const u64 = (b, o) => b.readBigUInt64LE(o), u128 = (b, o) => b.readBigUInt64LE(o) + (b.readBigUInt64LE(o + 8) << 64n);
const M128 = (1n << 128n) - 1n, sub128 = (a, b) => (a - b) & M128;   // compteurs Uniswap : arithmétique modulo 2^128
const discEvt = n => crypto.createHash('sha256').update('event:' + n).digest().subarray(0, 8).toString('hex');
const EVT_RAY = { [discEvt('CreatePersonalPositionEvent')]: 'create', [discEvt('IncreaseLiquidityEvent')]: 'inc',
    [discEvt('DecreaseLiquidityEvent')]: 'dec', [discEvt('LiquidityCalculateEvent')]: 'calc' };

async function compteSol(adresse) {
    const r = await rpc('solana', 'getAccountInfo', [adresse, { encoding: 'base64' }]);
    return r && r.value ? Buffer.from(r.value.data[0], 'base64') : null;
}
async function symbolesSolana(mints) {
    const out = {};
    try {
        const r = await axios.get('https://api.dexscreener.com/tokens/v1/solana/' + mints.join(','), { timeout: 10000 });
        for (const p of r.data || []) for (const t of [p.baseToken, p.quoteToken]) if (t && mints.includes(t.address) && !out[t.address]) out[t.address] = t.symbol;
    } catch (_) {}
    return out;
}
// PoolState : mints 73/105, décimales 233/234, tick_spacing 235, sqrt_price_x64 253, tick 269, croissance des frais 277/293
async function poolRaydium(poolId) {
    const q = await compteSol(poolId);
    if (!q) throw new Error('pool Raydium illisible');
    const k = 'solana:' + poolId;
    if (!E.pools[k]) {
        const m0 = b58(q.subarray(73, 105)), m1 = b58(q.subarray(105, 137));
        const syms = await symbolesSolana([m0, m1]);
        E.tokens['solana:' + m0] = { adr: m0, dec: q[233], sym: syms[m0] || m0.slice(0, 4) };
        E.tokens['solana:' + m1] = { adr: m1, dec: q[234], sym: syms[m1] || m1.slice(0, 4) };
        E.pools[k] = { t0: m0, t1: m1 };
    }
    return { ...E.pools[k], ts: q.readUInt16LE(235), sp: u128(q, 253), tick: q.readInt32LE(269), g0: u128(q, 277), g1: u128(q, 293) };
}
// TickArrayState (10 240 octets) : pool à 8, premier tick à 40, 60 TickState de 168 octets à partir de 44
async function tickRaydium(poolId, ts, t) {
    const span = 60 * ts, start = Math.floor(t / span) * span;
    const sb = Buffer.alloc(4); sb.writeInt32LE(start);
    const r = await rpc('solana', 'getProgramAccounts', [C.chaines.solana.programme, { encoding: 'base64',
        filters: [{ dataSize: 10240 }, { memcmp: { offset: 8, bytes: poolId } }, { memcmp: { offset: 40, bytes: b58(sb) } }] }]);
    if (!r || !r.length) return null;
    const d = Buffer.from(r[0].account.data[0], 'base64'), o = 44 + ((t - start) / ts) * 168;
    if (d.readInt32LE(o) !== t) return null;                  // garde-fou : la borne lue doit être la nôtre
    return { out0: u128(d, o + 36), out1: u128(d, o + 52) };
}
// PersonalPositionState : bornes 73/77, liquidité 81, croissance lue 97/113, frais dus 129/137
async function mesurerRaydium(entree) {
    const ch = 'solana', k = `${ch}:${entree.mint}`;
    const p = await compteSol(entree.compte);
    if (!p) return null;
    const L = u128(p, 81);
    if (L === 0n) return null;
    const tl = p.readInt32LE(73), tu = p.readInt32LE(77);
    const pool = await poolRaydium(entree.poolId);
    const t0 = E.tokens[ch + ':' + pool.t0], t1 = E.tokens[ch + ':' + pool.t1];
    let P = E.positions[k];
    if (!P) {
        P = E.positions[k] = { ch, id: entree.mint, ev: [], source: 'liste', suivi: { dansMs: 0, totalMs: 0, dernier: null, dernierDans: null } };
        log(`nouvelle position suivie : ${k.slice(0, 20)}… ${t0.sym}/${t1.sym}`);
    }
    Object.assign(P, { pool: entree.poolId, t0: pool.t0, t1: pool.t1, tl, tu, compte: entree.compte, absent: 0 });
    P.premiereVue = P.premiereVue || Date.now(); delete P.fermeeA;
    // frais en attente = dus + L × (croissance des frais dans la fourchette − dernière croissance lue) / 2^64
    let f0 = 0, f1 = 0, fraisLus = false;
    const lo = await tickRaydium(entree.poolId, pool.ts, tl), up = await tickRaydium(entree.poolId, pool.ts, tu);
    if (lo && up) {
        const b0 = pool.tick >= tl ? lo.out0 : sub128(pool.g0, lo.out0), b1 = pool.tick >= tl ? lo.out1 : sub128(pool.g1, lo.out1);
        const h0 = pool.tick < tu ? up.out0 : sub128(pool.g0, up.out0), h1 = pool.tick < tu ? up.out1 : sub128(pool.g1, up.out1);
        const i0 = sub128(sub128(pool.g0, b0), h0), i1 = sub128(sub128(pool.g1, b1), h1);
        f0 = Number(u64(p, 129) + ((L * sub128(i0, u128(p, 97))) >> 64n)) / 10 ** t0.dec;
        f1 = Number(u64(p, 137) + ((L * sub128(i1, u128(p, 113))) >> 64n)) / 10 ** t1.dec;
        fraisLus = true;
    }
    const sp = Number(pool.sp) / 2 ** 64, dans = pool.tick >= tl && pool.tick < tu;
    const [r0, r1] = montants(L, sp, tl, tu);
    const a0 = r0 / 10 ** t0.dec, a1 = r1 / 10 ** t1.dec;
    const prix0en1 = sp * sp * 10 ** (t0.dec - t1.dec);
    const [p0, p1] = await prixPaire(ch, t0, t1, prix0en1, null, entree.poolId);
    if (P.prixPremiereVue == null) { P.prixPremiereVue = prix0en1; P.premiereVueMontants = [a0, a1]; P.premiereVuePrix = [p0, p1]; }
    const S = P.suivi, now = Date.now();
    if (S.dernier && now - S.dernier < 45 * 60e3) { const dt = now - S.dernier; S.totalMs += dt; if (S.dernierDans) S.dansMs += dt; }
    S.dernier = now; S.dernierDans = dans;
    const pl = Math.pow(1.0001, tl) * 10 ** (t0.dec - t1.dec), pu = Math.pow(1.0001, tu) * 10 ** (t0.dec - t1.dec);
    const m = { cle: k, stakee: false, dans, tick: pool.tick, posDansPct: dans ? 100 * (pool.tick - tl) / (tu - tl) : null,
        fourchette: [pl, pu], prix: prix0en1, largeurPct: 100 * (pu - pl) / ((pu + pl) / 2),
        montants: [a0, a1], prixUsd: [p0, p1], valeur: p0 != null && p1 != null ? a0 * p0 + a1 * p1 : null,
        fraisNonCollectes: [f0, f1], fraisLus, recomp: null, dansPct: S.totalMs > 0 ? 100 * S.dansMs / S.totalMs : (dans ? 100 : 0),
        suiviDepuis: P.premiereVue, mesureA: now };
    calculs[k] = m;
    return m;
}
// une transaction du wallet → événements Raydium appliqués aux positions (ouverture, ajout, retrait, fermeture)
async function traiterTxSolana(sig, tx) {
    const logs = tx.meta?.logMessages || [];
    if (!logs.some(l => l.includes(C.chaines.solana.programme))) return 0;
    const t = tx.blockTime, slot = tx.slot, wallet = C.chaines.solana.wallet;
    const nftAvant = new Set((tx.meta.preTokenBalances || []).filter(b => b.owner === wallet && b.uiTokenAmount.decimals === 0 && b.uiTokenAmount.amount === '1').map(b => b.mint));
    const nftApres = new Set((tx.meta.postTokenBalances || []).filter(b => b.owner === wallet && b.uiTokenAmount.decimals === 0 && b.uiTokenAmount.amount === '1').map(b => b.mint));
    let sp = null, n = 0, gasFait = false;
    const ajouter = async (P, e) => {
        const t0 = E.tokens['solana:' + P.t0], t1 = E.tokens['solana:' + P.t1];
        if (P.ev.some(x => x.tx === e.tx && x.li === e.li)) return;
        e.a0 = Number(e.r0) / 10 ** t0.dec; e.a1 = Number(e.r1) / 10 ** t1.dec;
        const prix0en1 = sp != null ? Math.pow(Number(sp) / 2 ** 64, 2) * 10 ** (t0.dec - t1.dec) : null;
        if (prix0en1 != null && e.type !== 'col') e.prix0en1 = prix0en1;
        [e.p0, e.p1] = await prixPaire('solana', t0, t1, prix0en1, t * 1000, P.pool);
        if (!gasFait) {                                       // frais de transaction Solana, une fois par transaction
            gasFait = true; e.gasCompte = true;
            const ps = await prixAncreA('SOL', t * 1000);
            e.gasUsd = ps ? tx.meta.fee / 1e9 * ps : 0;
        }
        P.ev.push(e); P.ev.sort((a, b) => a.blk - b.blk || a.li - b.li); n++;
    };
    let li = 0;
    for (const l of logs) {
        li++;
        if (!l.startsWith('Program data: ')) continue;
        const b = Buffer.from(l.slice(14), 'base64'), type = EVT_RAY[b.subarray(0, 8).toString('hex')];
        if (!type) continue;
        if (type === 'calc') { sp = u128(b, 24); continue; }  // prix de la pool au moment de l'opération
        if (type === 'create') {
            const poolId = b58(b.subarray(8, 40)), nft = [...nftApres].find(m => !nftAvant.has(m));
            if (!nft) continue;
            const pool = await poolRaydium(poolId), k = 'solana:' + nft;
            const P = E.positions[k] = E.positions[k] || { ch: 'solana', id: nft, ev: [], source: 'historique', suivi: { dansMs: 0, totalMs: 0, dernier: null, dernierDans: null } };
            Object.assign(P, { pool: poolId, t0: pool.t0, t1: pool.t1, tl: b.readInt32LE(104), tu: b.readInt32LE(108) });
            P.premiereVue = P.premiereVue || Date.now(); P.pret = true;
            await ajouter(P, { type: 'inc', blk: slot, tx: sig, li, t, liq: u128(b, 112).toString(), r0: u64(b, 128).toString(), r1: u64(b, 136).toString() });
        } else {
            const P = E.positions['solana:' + b58(b.subarray(8, 40))];
            if (!P || !P.t0) continue;                        // position ouverte avant la fenêtre de 60 jours
            const liq = u128(b, 40).toString(), x0 = u64(b, 56), x1 = u64(b, 64);
            if (type === 'inc') await ajouter(P, { type: 'inc', blk: slot, tx: sig, li, t, liq, r0: x0.toString(), r1: x1.toString() });
            else {                                            // retrait : capital (dec) + capital et frais versés (col), comme sur EVM
                await ajouter(P, { type: 'dec', blk: slot, tx: sig, li, t, liq, r0: x0.toString(), r1: x1.toString() });
                await ajouter(P, { type: 'col', blk: slot, tx: sig, li: li + 0.5, t, liq: null, r0: (x0 + u64(b, 72)).toString(), r1: (x1 + u64(b, 80)).toString() });
            }
        }
    }
    // fermeture : le NFT de position disparaît du wallet (brûlé)
    if (logs.some(l => /Instruction: ClosePosition/.test(l)))
        for (const m of nftAvant) if (!nftApres.has(m) && E.positions['solana:' + m]) { E.positions['solana:' + m].fermeeA = t * 1000; delete calculs['solana:' + m]; }
    return n;
}
// remonte les transactions du wallet Solana dans l'ORDRE CHRONOLOGIQUE (Solana les renvoie de la plus récente à la
// plus ancienne : lues dans cet ordre, une fermeture arriverait avant l'ouverture et le retrait serait perdu).
// 1) une fois : liste des signatures des 60 derniers jours ; 2) lecture par lots de 40, de la plus ancienne ;
// 3) ensuite, seulement les nouvelles signatures.
async function scanSolana() {
    const conf = C.chaines.solana;
    if (!conf) return;
    const S = E.sol = E.sol || { plusRecente: null, aLire: null };
    if (!S.aLire) {
        const limite = Date.now() / 1000 - DECOUVERTE_JOURS * 86400, liste = [];
        let avant = null;
        for (let page = 0; page < 10; page++) {
            const L = await rpc('solana', 'getSignaturesForAddress', [conf.wallet, avant ? { before: avant, limit: 1000 } : { limit: 1000 }]);
            if (!L.length) break;
            if (!S.plusRecente) S.plusRecente = L[0].signature;
            let fin = false;
            for (const x of L) { if ((x.blockTime || 0) < limite) { fin = true; break; } if (!x.err) liste.push(x.signature); }
            if (fin || L.length < 1000) break;
            avant = L[L.length - 1].signature;
        }
        S.aLire = liste.reverse();                            // de la plus ancienne à la plus récente
        log(`solana : ${S.aLire.length} transaction(s) du wallet à relire (${DECOUVERTE_JOURS} jours)`);
    } else if (!S.aLire.length && S.plusRecente) {
        const L = await rpc('solana', 'getSignaturesForAddress', [conf.wallet, { until: S.plusRecente, limit: 1000 }]);
        if (L.length) { S.plusRecente = L[0].signature; S.aLire = L.filter(x => !x.err).map(x => x.signature).reverse(); }
    }
    let n = 0;
    while (S.aLire.length && n < 40) {
        const sig = S.aLire[0];
        const tx = await rpc('solana', 'getTransaction', [sig, { maxSupportedTransactionVersion: 0, encoding: 'json' }]);
        if (tx) await traiterTxSolana(sig, tx);
        S.aLire.shift(); n++;
    }
    if (n && !S.aLire.length) log(`solana : historique du wallet à jour`);
}

// ── Travail de fond (toutes les minutes) ──────────────────────────────────────────────────────
async function travailFond() {
    if (!C || fondEnCours) return;
    fondEnCours = true;
    try {
        const rpcFait = new Set(), enPanne = new Set();   // chaîne dont l'explorateur refuse : on la saute jusqu'au passage suivant
        if (C.chaines.solana) {
            try { await scanSolana(); } catch (e) { log('solana : historique pas encore disponible — ' + e.message); }
        }
        for (const P of Object.values(E.positions)) {
            if (!P.t0 || enPanne.has(P.ch) || P.ch === 'solana') continue;
            if (P.gauge && !P.gaugeVerifie && P.source === 'explorateur') {   // positions découvertes avant ce contrôle
                try { await appel(P.ch, P.gauge, '0xf7c618c1'); } catch (e) { if (e.revert) { delete P.gauge; delete P.reclame; } }
                P.gaugeVerifie = true;
            }
            try {
                if (P.ev.some(e => e.p1 === undefined || e.p0 == null || e.p1 == null)) {     // prix manquants (réseau) : on réessaie
                    for (const e of P.ev) if (e.p0 == null || e.p1 == null) delete e.p1;
                    await enrichir(P);
                }
                if (explorateur(P.ch)) {
                    const due = !P.pret || (!P.fermeeA && Date.now() - (P.rafraichiA || 0) > RAFRAICHIR_MS) || (P.fermeeA && !P.fermetureLue);
                    if (due) { await rafraichir(P); if (P.fermeeA) P.fermetureLue = true; }
                } else if (!rpcFait.has(P.ch) && (!P.fermeeA || !P.scan || P.scan.haut < (P.blocFermeture || 0))) {
                    rpcFait.add(P.ch);                       // une seule fenêtre RPC par chaîne et par minute
                    await scanRpc(P);
                }
            } catch (e) {
                log(`${P.ch}:${P.id} : historique pas encore disponible — ${e.message}`);
                if (/429|explorateur|rate/i.test(e.message)) enPanne.add(P.ch);
            }
        }
        // ensuite seulement, la découverte des positions passées (lente, par lots)
        for (const ch of Object.keys(C.chaines)) {
            if (explorateur(ch) && !enPanne.has(ch) && Date.now() >= ((E.prochaineDecouverte || {})[ch] || 0)) {
                try { await decouvrir(ch); }
                catch (e) { log(`${ch} : découverte impossible — ${e.message}`); (E.prochaineDecouverte = E.prochaineDecouverte || {})[ch] = Date.now() + 10 * 60e3; }
            }
        }
        sauver();
    } finally { fondEnCours = false; }
}

// ── Mesure en direct d'une position ouverte ───────────────────────────────────────────────────
async function mesurerPosition(ch, entree) {
    const conf = C.chaines[ch], id = String(entree.tokenId), k = `${ch}:${id}`;
    const pos = decoderPosition(await appel(ch, conf.nfpm, '0x99fbab88' + pad(id)));
    if (pos.liquidity === 0n) return null;
    const t0 = await infoToken(ch, pos.token0), t1 = await infoToken(ch, pos.token1);
    let P = E.positions[k];
    if (!P) {
        P = E.positions[k] = { ch, id, ev: [], source: 'liste', suivi: { dansMs: 0, totalMs: 0, dernier: null, dernierDans: null } };
        log(`nouvelle position suivie : ${k} ${t0.sym}/${t1.sym}`);
    }
    P.pool = P.pool || entree.pool.toLowerCase(); P.t0 = t0.adr; P.t1 = t1.adr;
    P.tl = pos.tickLower; P.tu = pos.tickUpper; P.absent = 0; P.premiereVue = P.premiereVue || Date.now();
    delete P.fermeeA;
    // propriétaire : le wallet (non stakée) ou un gauge Velodrome (stakée → récompenses au lieu des frais)
    let owner = null;
    try { owner = '0x' + (await appel(ch, conf.nfpm, '0x6352211e' + pad(id))).slice(-40).toLowerCase(); } catch (_) {}
    const stakee = !!owner && owner !== C.wallet;
    if (stakee) P.gauge = owner;
    const s0 = (await appel(ch, P.pool, '0x3850c7bd')).slice(2);              // slot0()
    const sp = Number(BigInt('0x' + s0.slice(0, 64))) / 2 ** 96, tick = s256(s0.slice(64, 128));
    const dans = tick >= P.tl && tick < P.tu;
    const [r0, r1] = montants(pos.liquidity, sp, P.tl, P.tu);
    const a0 = r0 / 10 ** t0.dec, a1 = r1 / 10 ** t1.dec;
    const prix0en1 = sp * sp * 10 ** (t0.dec - t1.dec);
    const [p0, p1] = await prixPaire(ch, t0, t1, prix0en1, null, P.pool);
    if (P.prixPremiereVue == null) { P.prixPremiereVue = prix0en1; P.premiereVueMontants = [a0, a1]; P.premiereVuePrix = [p0, p1]; }
    // frais non collectés : simulation de collect() par le propriétaire (impossible si stakée)
    let f0 = 0, f1 = 0, recomp = null;
    if (!stakee) {
        const M = (1n << 128n) - 1n;
        const r = (await appel(ch, conf.nfpm, '0xfc6f7865' + pad(id) + padAdr(C.wallet) + pad(M) + pad(M), C.wallet)).slice(2);
        f0 = Number(BigInt('0x' + r.slice(0, 64))) / 10 ** t0.dec; f1 = Number(BigInt('0x' + r.slice(64, 128))) / 10 ** t1.dec;
    } else {
        try {
            const rt = '0x' + (await appel(ch, owner, '0xf7c618c1')).slice(-40);                          // rewardToken()
            const tr = await infoToken(ch, rt);
            P.recompToken = tr.adr;
            const q = Number(BigInt(await appel(ch, owner, '0x3e491d47' + padAdr(C.wallet) + pad(id)))) / 10 ** tr.dec;   // earned()
            const reclame = await reclamations(P);
            const pr = await prixDexScreener(ch, rt);
            P.prixRecomp = pr;
            recomp = { sym: tr.sym, enAttente: q, reclame, usd: pr != null ? (q + reclame) * pr : null };
        } catch (_) { /* gauge non standard : pas de récompenses lisibles */ }
    }
    // temps dans la fourchette, échantillons de 15 min depuis le début du suivi
    const S = P.suivi, now = Date.now();
    if (S.dernier && now - S.dernier < 45 * 60e3) { const dt = now - S.dernier; S.totalMs += dt; if (S.dernierDans) S.dansMs += dt; }
    S.dernier = now; S.dernierDans = dans;
    const pl = Math.pow(1.0001, P.tl) * 10 ** (t0.dec - t1.dec), pu = Math.pow(1.0001, P.tu) * 10 ** (t0.dec - t1.dec);
    const m = { cle: k, stakee, dans, tick, posDansPct: dans ? 100 * (tick - P.tl) / (P.tu - P.tl) : null,
        fourchette: [pl, pu], prix: prix0en1, largeurPct: 100 * (pu - pl) / ((pu + pl) / 2),
        montants: [a0, a1], prixUsd: [p0, p1], valeur: p0 != null && p1 != null ? a0 * p0 + a1 * p1 : null,
        fraisNonCollectes: [f0, f1], recomp, dansPct: S.totalMs > 0 ? 100 * S.dansMs / S.totalMs : (dans ? 100 : 0),
        suiviDepuis: P.premiereVue, mesureA: now };
    if (!stakee && dans) m.aprPoolPct = await aprPool(ch, P.pool);
    calculs[k] = m;
    return m;
}
// récompenses déjà réclamées sur le gauge (positions stakées), entre l'ouverture et la fermeture
async function reclamations(P) {
    if (!P.gauge || !explorateur(P.ch) || !P.ev.length) return P.reclame || 0;
    const tr = E.tokens[P.ch + ':' + P.recompToken] || { dec: 18 };
    const de = P.ev[0].blk, a = P.fermeeA ? P.ev[P.ev.length - 1].blk : 'latest';
    const L = await explGet(P.ch, { module: 'logs', action: 'getLogs', fromBlock: de, toBlock: a, address: P.gauge,
        topic0: T_CLAIM, topic1: '0x' + padAdr(C.wallet), topic0_1_opr: 'and' });
    P.reclame = L.reduce((s, l) => s + Number(BigInt(l.data.slice(0, 66))) / 10 ** tr.dec, 0);
    return P.reclame;
}
// position fermée découverte après coup : on retrouve le jeton de récompense du gauge, puis les réclamations
async function reclamationsSansJeton(P) {
    try {
        if (!P.recompToken) {
            const rt = '0x' + (await appel(P.ch, P.gauge, '0xf7c618c1')).slice(-40);
            P.recompToken = (await infoToken(P.ch, rt)).adr;
        }
        await reclamations(P);
        if (P.prixRecomp == null) P.prixRecomp = await prixDexScreener(P.ch, P.recompToken);
    } catch (_) { /* pas un gauge : rien à compter */ }
}
// APR moyen de la pool (volume 24 h × frais ÷ TVL, DexScreener) — pour le conseil « resserrer »
const _aprPool = new Map();
async function aprPool(ch, pool) {
    const c = _aprPool.get(pool);
    if (c && Date.now() - c.t < 3600e3) return c.v;
    let v = null;
    try {
        const fee = parseInt(await appel(ch, pool, '0xddca3f43'), 16) / 1e6;    // fee() : 3000 = 0,3 %
        const r = await axios.get(`https://api.dexscreener.com/latest/dex/pairs/${C.chaines[ch].dexscreener}/${pool}`, { timeout: 10000 });
        const p = (r.data?.pairs || [])[0];
        if (p && p.liquidity?.usd > 0) v = 100 * (p.volume?.h24 || 0) * fee / p.liquidity.usd * 365;
    } catch (_) {}
    _aprPool.set(pool, { t: Date.now(), v });
    return v;
}

// ── Bilan d'une position (ouverte : mesure en direct ; fermée : événements seuls) ─────────────
function bilanPosition(P) {
    const k = `${P.ch}:${P.id}`, live = !P.fermeeA ? calculs[k] : null;
    // historique utilisable seulement si chaque événement a ses prix (sinon : base = première vue, signalée)
    // Solana : l'historique n'est complet qu'une fois TOUTE la relecture du wallet faite (sinon un encaissement de
    // frais plus récent que l'ouverture manque encore — vu le 16/10 : verdict ❌ affiché pendant la relecture)
    const solEnCours = P.ch === 'solana' && !(E.sol && E.sol.aLire && E.sol.aLire.length === 0);
    const evOk = !solEnCours && P.pret && P.ev.some(e => e.type === 'inc') && P.ev.every(e => e.p0 != null && e.p1 != null);
    if (!live && !(P.fermeeA && evOk)) return null;
    let d0 = 0, d1 = 0, w0 = 0, w1 = 0, c0 = 0, c1 = 0, cap = 0, ret = 0, gas = 0, ouv = null, p0e = null, p1e = null, fin = null;
    if (evOk) {
        for (const e of P.ev) {
            gas += e.gasUsd || 0;
            if (e.type === 'inc') { d0 += e.a0; d1 += e.a1; cap += e.a0 * (e.p0 || 0) + e.a1 * (e.p1 || 0); if (ouv == null) { ouv = e.t * 1000; p0e = e.p0; p1e = e.p1; } }
            if (e.type === 'dec') { w0 += e.a0; w1 += e.a1; ret += e.a0 * (e.p0 || 0) + e.a1 * (e.p1 || 0); fin = e; }
            if (e.type === 'col') { c0 += e.a0; c1 += e.a1; }
        }
    } else {                                                  // historique pas encore lu : base = première vue
        [d0, d1] = P.premiereVueMontants; [p0e, p1e] = P.premiereVuePrix;
        cap = d0 * (p0e || 0) + d1 * (p1e || 0); ouv = P.premiereVue;
    }
    const fc0 = Math.max(0, c0 - w0), fc1 = Math.max(0, c1 - w1);             // Collect = frais + capital retiré
    const t0 = E.tokens[P.ch + ':' + P.t0], t1 = E.tokens[P.ch + ':' + P.t1];
    const b = { cle: k, id: P.id, ouverte: !P.fermeeA, ouverture: ouv, fermeture: P.fermeeA || null, capital: cap, gas,
        sym0: t0?.sym, sym1: t1?.sym, prixEntree: [p0e, p1e], base: evOk ? 'chaîne' : 'première vue', stakee: !!P.gauge };
    let p0, p1, valeur, recompUsd = 0;
    if (live) {
        [p0, p1] = live.prixUsd; valeur = live.valeur;
        if (p0 == null || p1 == null || valeur == null) return null;
        b.frais = (live.fraisNonCollectes[0] + fc0) * p0 + (live.fraisNonCollectes[1] + fc1) * p1;
        recompUsd = live.recomp?.usd || 0;
        Object.assign(b, { dans: live.dans, posDansPct: live.posDansPct, dansPct: live.dansPct, suiviDepuis: live.suiviDepuis,
            largeurPct: live.largeurPct, aprPoolPct: live.aprPoolPct, recomp: live.recomp, valeur });
    } else {
        if (!fin || fin.p0 == null || fin.p1 == null) return null;
        [p0, p1] = [fin.p0, fin.p1]; valeur = 0;                // tout est retiré : on valorise au prix de la fermeture
        b.frais = fc0 * p0 + fc1 * p1;
        if (P.gauge && P.reclame) recompUsd = P.reclame * (P.prixRecomp || 0);
        b.dansPct = P.suivi && P.suivi.totalMs > 0 ? 100 * P.suivi.dansMs / P.suivi.totalMs : null;
    }
    if (live && !evOk) b.frais = (live.fraisNonCollectes[0]) * p0 + (live.fraisNonCollectes[1]) * p1;
    b.prixFin = [p0, p1];
    b.ageH = ((P.fermeeA || Date.now()) - ouv) / 3600e3;
    b.recompUsd = recompUsd; b.gains = b.frais + recompUsd;
    const deposeFin = d0 * p0 + d1 * p1;                      // les jetons déposés, gardés tels quels (HOLD)
    const renduLp = valeur + w0 * p0 + w1 * p1;               // ce que la LP a rendu ou contient, au même prix
    b.hold = deposeFin;
    b.divergence = renduLp - deposeFin;
    b.effetLp = b.divergence + b.gains;                        // = vs HOLD
    b.effetMarche = deposeFin - cap;                           // ce qu'aurait fait le HOLD
    b.pnl = valeur + ret + b.gains - cap - gas;
    b.roiPct = cap > 0 ? 100 * b.pnl / cap : null;
    b.aprPct = cap > 0 && b.ageH > 0.5 ? 100 * b.gains / cap * 8760 / b.ageH : null;
    return b;
}

// ── Stratégies : toutes les positions d'une même pool, tant qu'il n'y a pas 7 jours de trou ────
function strategies() {
    const parPool = {};
    for (const P of Object.values(E.positions)) {
        if (!P.pool || !P.t0) continue;
        (parPool[`${P.ch}:${P.pool}`] = parPool[`${P.ch}:${P.pool}`] || []).push(P);
    }
    const out = [];
    for (const [cle, L] of Object.entries(parPool)) {
        const B = L.map(bilanPosition).filter(Boolean).sort((a, b) => a.ouverture - b.ouverture);
        let groupe = [], finPrec = null;
        const pousser = () => { if (groupe.length) out.push(agreger(cle, groupe)); groupe = []; };
        for (const b of B) {
            if (finPrec != null && b.ouverture - finPrec > ECART_STRATEGIE_J * 86400e3) pousser();
            groupe.push(b);
            finPrec = Math.max(finPrec || 0, b.fermeture || Date.now());
        }
        pousser();
    }
    return out.sort((a, b) => (b.enCours ? 1 : 0) - (a.enCours ? 1 : 0) || b.fin - a.fin);
}
function agreger(cle, B) {
    const ch = cle.split(':')[0], conf = C.chaines[ch], prem = B[0], der = B[B.length - 1];
    const S = { cle, chaine: conf.nom, protocole: conf.protocole, paire: `${prem.sym0}/${prem.sym1}`, sym0: prem.sym0, sym1: prem.sym1,
        n: B.length, positions: B, enCours: B.find(b => b.ouverte) || null, debut: prem.ouverture,
        fin: B.some(b => b.ouverte) ? Date.now() : Math.max(...B.map(b => b.fermeture)), stakee: B.some(b => b.stakee) };
    const somme = f => B.reduce((a, b) => a + (b[f] || 0), 0);
    Object.assign(S, { pnl: somme('pnl'), gains: somme('gains'), gas: somme('gas'), effetLp: somme('effetLp'), effetMarche: somme('effetMarche') });
    S.dureeH = (S.fin - S.debut) / 3600e3;
    S.dureeMoyH = somme('ageH') / S.n;
    S.capital = prem.capital;
    // APR seulement sur un historique complet et au moins 1 h : sinon les récompenses accumulées avant le début
    // du suivi, rapportées à quelques minutes, donnent des APR absurdes (75 810 % vu en test)
    S.complete = B.every(b => b.base === 'chaîne');
    const capTemps = B.reduce((a, b) => a + b.capital * b.ageH / 8760, 0);
    S.aprPct = S.complete && capTemps > 0 && S.dureeH >= 1 ? 100 * S.gains / capTemps : null;
    S.roiPct = S.capital > 0 ? 100 * S.pnl / S.capital : null;
    // vs garder 100 % d'un jeton depuis le début de la stratégie (capital de la première position)
    const [p0e, p1e] = prem.prixEntree, [p0f, p1f] = (S.enCours || der).prixFin;
    S.vs100_0 = p0e && p0f ? S.pnl - (S.capital / p0e * p0f - S.capital) : null;
    S.vs100_1 = p1e && p1f ? S.pnl - (S.capital / p1e * p1f - S.capital) : null;
    S.verdict = verdictStrategie(S);
    return S;
}
function verdictStrategie(S) {
    const mot = S.stakee ? 'récompenses' : 'frais', cur = S.enCours;
    if (!S.complete) return { icone: '⏳', texte: 'Historique de la position en cours de lecture : verdict au prochain bilan' };
    if (S.dureeH < AGE_VERDICT_H) return { icone: '⏳', texte: `Trop tôt pour juger (${duree(S.dureeH)}, verdict à partir de ${AGE_VERDICT_H} h)` };
    if (cur && cur.dansPct != null && cur.ageH >= AGE_VERDICT_H && cur.dansPct < DANS_MIN_PCT)
        return { icone: '❌', texte: `Élargis la fourchette : la position en cours en est sortie ${fr(100 - cur.dansPct, 0)} % du temps.` };
    if (S.effetLp < 0) {
        if (S.n >= 3 && S.dureeMoyH < 24)
            return { icone: '❌', texte: `Élargis la fourchette : ${S.n} positions en ${duree(S.dureeH)} (${duree(S.dureeMoyH)} en moyenne), et les ${mot} ne couvrent pas la divergence (${signe(S.effetLp)} $).` };
        return { icone: '❌', texte: `Change de paire ou de stratégie : sur ${S.n} position${S.n > 1 ? 's' : ''}, les ${mot} (${fr(S.gains)} $) ne couvrent pas la divergence (${fr(S.gains - S.effetLp)} $).` };
    }
    if (S.gains > 0 && S.gas > 0.3 * S.gains)
        return { icone: '⚠️', texte: `Le gas mange ${fr(100 * S.gas / S.gains, 0)} % des ${mot} : rouvre moins souvent ou élargis.` };
    if (cur && cur.dans === false)
        return { icone: '⚠️', texte: `Stratégie gagnante (${signe(S.effetLp)} $ vs HOLD), mais la position en cours est HORS fourchette : elle ne rapporte plus rien.` };
    if (cur && !cur.stakee && cur.dansPct >= 98 && cur.aprPoolPct != null && cur.aprPct != null && cur.aprPct < cur.aprPoolPct)
        return { icone: '⚠️', texte: `Tu peux resserrer : toujours dans la fourchette, mais ton APR (${fr(cur.aprPct, 0)} %) est sous celui de la pool (${fr(cur.aprPoolPct, 0)} %).` };
    return { icone: '✅', texte: `Garde : sur ${S.n} position${S.n > 1 ? 's' : ''}, les ${mot} battent la divergence (${signe(S.effetLp)} $ vs HOLD).` };
}

// ── Synthèse ──────────────────────────────────────────────────────────────────────────────────
function maintenantParis() {
    const p = Object.fromEntries(new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit',
        day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(new Date()).map(x => [x.type, x.value]));
    return { jour: `${p.year}-${p.month}-${p.day}`, heure: Number(p.hour) % 24, court: `${p.day}/${p.month}` };
}
const jourParis = ms => new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit' }).format(new Date(ms));
const idCourt = id => String(id).length > 12 ? String(id).slice(0, 6) + '…' : String(id);   // NFT Solana = adresse de 44 caractères
function blocStrategie(S, maxFermees = 3) {
    const mot = S.stakee ? 'Récompenses' : 'Frais';
    const L = [`🧩 ${S.protocole} ${S.paire} (${S.chaine}) — ${S.n} position${S.n > 1 ? 's' : ''} depuis le ${jourParis(S.debut)} (${duree(S.dureeH)})`];
    L.push(`💰 PnL ${signe(S.pnl)} $ (${signe(S.roiPct, 1)} %) · ${mot} ${fr(S.gains)} $ · APR ${fr(S.aprPct, 0)} % · gas ${fr(S.gas)} $`);
    L.push(`⚖️ Effet LP ${signe(S.effetLp)} $ (${mot.toLowerCase()} − divergence) · effet marché ${signe(S.effetMarche)} $`);
    if (S.vs100_0 != null && S.vs100_1 != null) L.push(`↔️ vs 100 % ${S.sym1} ${signe(S.vs100_1)} $ · vs 100 % ${S.sym0} ${signe(S.vs100_0)} $`);
    const c = S.enCours;
    if (c) {
        const ou = c.dans === false ? ' · ⚠️ HORS fourchette'
            : c.posDansPct != null ? ` · prix à ${fr(c.posDansPct, 0)} % de la fourchette${c.posDansPct < 15 ? ' (près du bas)' : c.posDansPct > 85 ? ' (près du haut)' : ''}` : '';
        L.push(`📍 En cours #${idCourt(c.id)} : ${fr(c.valeur)} $ · depuis ${duree(c.ageH)} · dans la fourchette ${fr(c.dansPct, 0)} % du temps suivi${ou}`
            + `${c.base !== 'chaîne' ? ' (historique en cours de lecture)' : ''}`);
    }
    const fermees = S.positions.filter(b => !b.ouverte).reverse();
    for (const b of fermees.slice(0, maxFermees))
        L.push(`🏁 #${idCourt(b.id)} : ${jourParis(b.ouverture)} → ${jourParis(b.fermeture)} (${duree(b.ageH)}) · PnL ${signe(b.pnl)} $ · effet LP ${signe(b.effetLp)} $`);
    if (fermees.length > maxFermees) L.push(`   … et ${fermees.length - maxFermees} autre(s) position(s) fermée(s)`);
    L.push(`${S.verdict.icone} ${S.verdict.texte}`);
    return L.join('\n');
}
// synthèse du jour : stratégies en cours + celles fermées depuis la dernière synthèse
function construireSynthese(tout = false) {
    const { court } = maintenantParis();
    const depuis = Date.now() - 26 * 3600e3;
    const S = strategies().filter(s => tout ? s.fin > Date.now() - 30 * 86400e3 : (s.enCours || s.fin > depuis));
    if (!S.length) return null;
    return [`📊 Synthèse LP — ${court}`, ...S.map(s => blocStrategie(s))].join('\n\n');
}
async function peutEtreSynthese() {
    const { jour, heure } = maintenantParis();
    if (heure < HEURE_SYNTHESE || E.derniereSynthese === jour) return;
    const texte = construireSynthese();
    if (!texte) return;
    if (await C.sendAlert(texte)) { E.derniereSynthese = jour; sauver(); log('synthèse quotidienne envoyée'); }
}

// ── Boucle ────────────────────────────────────────────────────────────────────────────────────
async function mesurer() {
    const vues = new Set();
    for (const [ch, L] of Object.entries(listes)) {
        if (!C.chaines[ch]) continue;
        for (const entree of L || []) {
            try { const m = ch === 'solana' ? await mesurerRaydium(entree) : await mesurerPosition(ch, entree); if (m) vues.add(m.cle); }
            catch (e) { log(`${ch}:${entree.tokenId} : mesure impossible — ${e.message}`); }
        }
    }
    // une position ouverte absente de deux mesures de suite est vérifiée sur la chaîne avant d'être déclarée fermée
    for (const [k, P] of Object.entries(E.positions)) {
        if (P.fermeeA || vues.has(k) || !calculs[k]) continue;
        P.absent = (P.absent || 0) + 1;
        if (P.absent < 2) continue;
        try {
            if (P.ch === 'solana') {                                // compte de position fermé = position fermée
                const c = await compteSol(P.compte);
                if (c && u128(c, 81) !== 0n) continue;
            } else {
                const pos = decoderPosition(await appel(P.ch, C.chaines[P.ch].nfpm, '0x99fbab88' + pad(P.id)));
                if (pos.liquidity !== 0n) continue;
            }
        } catch (e) { if (!e.revert) continue; }                   // revert = NFT brûlé ; erreur réseau = on attend
        P.fermeeA = Date.now(); P.fermetureLue = false; delete calculs[k];
        if (!explorateur(P.ch)) try { P.blocFermeture = parseInt(await rpc(P.ch, 'eth_blockNumber', []), 16); } catch (_) {}
        log(`${k} : position fermée`);
    }
    sauver();
}

function init(cfg) {
    C = cfg; C.wallet = C.wallet.toLowerCase();
    charger();
    // pas de synthèse dans la foulée d'un déploiement après l'heure prévue : la première arrive au prochain matin
    const { jour, heure } = maintenantParis();
    if (!E.derniereSynthese && heure >= HEURE_SYNTHESE) E.derniereSynthese = jour;
    setInterval(() => { travailFond().catch(e => log('travail de fond : ' + e.message)); }, 60e3);
    log(`analyse LP active · ${Object.keys(E.positions).length} position(s) en mémoire · synthèse chaque jour à ${HEURE_SYNTHESE} h (Paris)`
        + ` · HyperEVM ${process.env.ETHERSCAN_API_KEY ? 'avec' : 'SANS'} clé Etherscan`);
}
// appelé à chaque cycle du bot (60 s) avec les listes déjà lues ; ne bloque jamais
function tick(nouvellesListes) {
    if (!C) return;
    for (const [ch, L] of Object.entries(nouvellesListes)) if (Array.isArray(L)) listes[ch] = L;
    if (mesureEnCours || Date.now() - derniereMesure < MESURE_MS) return;
    mesureEnCours = true; derniereMesure = Date.now();
    (async () => {
        try { await mesurer(); await peutEtreSynthese(); }
        catch (e) { log('mesure : ' + e.message); }
        finally { mesureEnCours = false; }
    })();
}
function etat() {
    return { majA: derniereMesure ? new Date(derniereMesure).toISOString() : null, prochaineSynthese: `${HEURE_SYNTHESE} h (Paris)`,
        derniereSynthese: E.derniereSynthese, etherscan: !!process.env.ETHERSCAN_API_KEY, strategies: strategies(),
        synthese: construireSynthese(true) };
}

module.exports = { init, tick, etat, _test: { mesurer, travailFond, construireSynthese, strategies, E: () => E,
    mesurerDirect: async L => { Object.assign(listes, L); await mesurer(); } } };
