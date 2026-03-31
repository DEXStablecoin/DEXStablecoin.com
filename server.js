/**
 * StableX DEX — Backend Server v4
 * Express + WebSocket | Persistent DB | On-chain Auto Delivery
 *
 * Cải tiến v4:
 *   - Giá tỷ giá lấy từ Forex (exchangerate.host / fxratesapi / fallback hardcode)
 *   - Volume lệnh bán: tự động reset mỗi 24h, giới hạn DAILY_LIMIT_USDT/token
 *   - Lệnh mua tối đa MAX_BUY_USDT mỗi giao dịch
 *   - Toàn bộ validation logic ở backend, frontend chỉ hiển thị
 *
 * Cách chạy:
 *   node setup-wallet.js
 *   SELLER_WALLET=<địa_chỉ> node server.js
 *
 * Dependencies: npm install express ws node-fetch @solana/web3.js @solana/spl-token
 */

'use strict';

const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const fetch      = require('node-fetch');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');
const readline   = require('readline');
const solanaWeb3 = require('@solana/web3.js');
const splToken   = require('@solana/spl-token');

// ═══════════════════════════════════════════════════
// BASE58 DECODER (không cần package bs58)
// ═══════════════════════════════════════════════════
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(str) {
  const bytes = [0];
  for (const char of str) {
    const val = BASE58_ALPHABET.indexOf(char);
    if (val < 0) throw new Error('Ký tự base58 không hợp lệ: ' + char);
    let carry = val;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const char of str) { if (char === '1') bytes.push(0); else break; }
  return Uint8Array.from(bytes.reverse());
}

// ═══════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════
const PORT          = process.env.PORT || 8080;
const MAX_USERS     = 10;
const DB_FILE       = path.join(__dirname, 'db.json');
const WALLET_FILE   = path.join(__dirname, 'wallet.enc');
const SELLER_WALLET = process.env.SELLER_WALLET || null;

// ── Giới hạn giao dịch ──
const DAILY_LIMIT_USDT = 50000;   // Volume bán tối đa mỗi 24h (tính theo USDT-equivalent)
const MAX_BUY_USDT     = 1000;    // Lệnh mua tối đa mỗi giao dịch (USDT-equivalent)
const PRICE_REFRESH_MS = 30 * 60 * 1000; // Làm mới tỷ giá Forex mỗi 30 phút

// Spread % thêm vào giá Forex để tạo lệnh bán (ví dụ 0.5%)
const SPREAD_TIERS = {
  eJPY:  [{ spread: 0.000 }, { spread: 0.008 }],  // best + tier2
  eCNY:  [{ spread: 0.000 }, { spread: 0.007 }],
  eUSDC: [{ spread: 0.000 }, { spread: 0.002 }],
};

const SOLANA_RPCS = [
  'https://api.mainnet-beta.solana.com',
  'https://rpc.ankr.com/solana',
];

const TOKEN_PROGRAM_ID = new solanaWeb3.PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

const PAYMENT_TOKENS = {
  USDT:  { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6 },
  USDC:  { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
  eUSDC: { mint: '6VwnrGyk8XutR8ZM444Lyq8geo2hAcAtB7vMXf7LHTAJ', decimals: 6 },
};

const SELL_TOKENS = {
  eJPY:  { mint: 'HwbwHTKkze4hzF4SSz1Tj3cAb5f2qXd2e8gbFTPXUcj3', decimals: 6 },
  eCNY:  { mint: 'ABetScri1grGy52wxmq6PGC9kG9B7Z6PVx74B4DQxzUt', decimals: 6 },
  eUSDC: { mint: '6VwnrGyk8XutR8ZM444Lyq8geo2hAcAtB7vMXf7LHTAJ', decimals: 6 },
};

// ═══════════════════════════════════════════════════
// FOREX PRICE ENGINE
// ═══════════════════════════════════════════════════
// Lưu giá Forex hiện tại (USDT/eUSDC là base)
// Rate = số token per 1 USDT  → eJPY/USDT ~ 150, eCNY/USDT ~ 7.2
let FOREX_RATES = {
  eJPY:  150.00,  // fallback — sẽ được ghi đè bởi fetch thực
  eCNY:  7.20,
  eUSDC: 1.000,
};
let forexLastFetch = 0;
let forexSource = 'fallback';

/**
 * Fetch tỷ giá JPY/USD và CNY/USD từ nhiều nguồn
 * Ưu tiên: ExchangeRate.host → FxRatesAPI → Open Exchange Rates → hardcode
 */
async function fetchForexRates() {
  const now = Date.now();
  let jpyPerUsd = null, cnyPerUsd = null;

  // ── Nguồn 1: exchangerate-api.com (free, không cần key) ──
  try {
    const r = await fetch(
      'https://open.er-api.com/v6/latest/USD',
      { timeout: 8000 }
    );
    if (r.ok) {
      const d = await r.json();
      if (d?.rates?.JPY && d?.rates?.CNY) {
        jpyPerUsd = parseFloat(d.rates.JPY);
        cnyPerUsd = parseFloat(d.rates.CNY);
        forexSource = 'open.er-api.com';
      }
    }
  } catch(e) { console.warn('[FOREX] open.er-api.com failed:', e.message); }

  // ── Nguồn 2: fxratesapi.com (free fallback) ──
  if (!jpyPerUsd) {
    try {
      const r = await fetch(
        'https://api.fxratesapi.com/latest?base=USD&currencies=JPY,CNY',
        { timeout: 8000 }
      );
      if (r.ok) {
        const d = await r.json();
        if (d?.rates?.JPY && d?.rates?.CNY) {
          jpyPerUsd = parseFloat(d.rates.JPY);
          cnyPerUsd = parseFloat(d.rates.CNY);
          forexSource = 'fxratesapi.com';
        }
      }
    } catch(e) { console.warn('[FOREX] fxratesapi.com failed:', e.message); }
  }

  // ── Nguồn 3: currencyapi (free, no-key endpoint) ──
  if (!jpyPerUsd) {
    try {
      const r = await fetch(
        'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
        { timeout: 8000 }
      );
      if (r.ok) {
        const d = await r.json();
        if (d?.usd?.jpy && d?.usd?.cny) {
          jpyPerUsd = parseFloat(d.usd.jpy);
          cnyPerUsd = parseFloat(d.usd.cny);
          forexSource = 'fawazahmed0/currency-api (CDN)';
        }
      }
    } catch(e) { console.warn('[FOREX] currency-api CDN failed:', e.message); }
  }

  if (jpyPerUsd && cnyPerUsd && jpyPerUsd > 50 && cnyPerUsd > 5) {
    FOREX_RATES.eJPY  = parseFloat(jpyPerUsd.toFixed(3));
    FOREX_RATES.eCNY  = parseFloat(cnyPerUsd.toFixed(4));
    FOREX_RATES.eUSDC = 1.000;
    forexLastFetch = now;
    console.log(`[FOREX] ✅ ${forexSource} → eJPY=${FOREX_RATES.eJPY}, eCNY=${FOREX_RATES.eCNY}`);
  } else {
    console.warn('[FOREX] ⚠️ Tất cả nguồn thất bại, giữ giá hiện tại:', FOREX_RATES);
  }
}

/**
 * Tính rate của từng order dựa trên giá Forex + spread tier
 */
function buildOrderRates() {
  return {
    eJPY:  SPREAD_TIERS.eJPY.map(t  => parseFloat((FOREX_RATES.eJPY  * (1 + t.spread)).toFixed(3))),
    eCNY:  SPREAD_TIERS.eCNY.map(t  => parseFloat((FOREX_RATES.eCNY  * (1 + t.spread)).toFixed(4))),
    eUSDC: SPREAD_TIERS.eUSDC.map(t => parseFloat((FOREX_RATES.eUSDC * (1 + t.spread)).toFixed(4))),
  };
}

// ═══════════════════════════════════════════════════
// DAILY VOLUME TRACKER
// ═══════════════════════════════════════════════════
// dailyVolume[orderId] = { soldUsdt: number, resetAt: timestamp }
let dailyVolume = {};

function getWindowStart() {
  // Reset cửa sổ 24h theo ngày UTC (00:00 UTC)
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  return now.getTime();
}

function getDailyVolume(orderId) {
  const windowStart = getWindowStart();
  if (!dailyVolume[orderId] || dailyVolume[orderId].resetAt < windowStart) {
    dailyVolume[orderId] = { soldUsdt: 0, resetAt: windowStart };
  }
  return dailyVolume[orderId];
}

/**
 * Tính còn bao nhiêu USDT-equivalent có thể bán trong ngày hôm nay cho order này
 */
function remainingDailyCapacity(orderId) {
  const vol = getDailyVolume(orderId);
  return Math.max(0, DAILY_LIMIT_USDT - vol.soldUsdt);
}

/**
 * Sau khi giao dịch thành công, cộng volume vào counter
 * @param {number} orderId
 * @param {number} soldUsdt - số USDT equivalent đã bán
 */
function addDailyVolume(orderId, soldUsdt) {
  const vol = getDailyVolume(orderId);
  vol.soldUsdt += soldUsdt;
  saveDailyVolume();
  console.log(`[VOL] Order#${orderId}: ${vol.soldUsdt.toFixed(2)}/${DAILY_LIMIT_USDT} USDT used today`);
}

const VOLUME_FILE = path.join(__dirname, 'daily_volume.json');
function saveDailyVolume() {
  try { fs.writeFileSync(VOLUME_FILE, JSON.stringify(dailyVolume, null, 2)); } catch {}
}
function loadDailyVolume() {
  try {
    if (fs.existsSync(VOLUME_FILE)) {
      dailyVolume = JSON.parse(fs.readFileSync(VOLUME_FILE, 'utf8'));
      // Xóa các entry đã hết hạn
      const windowStart = getWindowStart();
      for (const id of Object.keys(dailyVolume)) {
        if (dailyVolume[id].resetAt < windowStart) delete dailyVolume[id];
      }
      console.log('[VOL] Daily volume loaded.');
    }
  } catch(e) { console.warn('[VOL] Load error:', e.message); }
}

// ═══════════════════════════════════════════════════
// ORDER BOOK — giá được tính từ Forex
// ═══════════════════════════════════════════════════
// Order template — rate sẽ được cập nhật động từ Forex
const ORDER_TEMPLATE = [
  // eJPY - thanh toán USDT
  { id: 1, token: 'eJPY',  tier: 0, payment: 'USDT'  },
  { id: 2, token: 'eJPY',  tier: 1, payment: 'USDT'  },
  // eCNY - thanh toán USDT
  { id: 3, token: 'eCNY',  tier: 0, payment: 'USDT'  },
  { id: 4, token: 'eCNY',  tier: 1, payment: 'USDT'  },
  // eUSDC - thanh toán USDC
  { id: 5, token: 'eUSDC', tier: 0, payment: 'USDC'  },
  { id: 6, token: 'eUSDC', tier: 1, payment: 'USDC'  },
  // eJPY - thanh toán eUSDC
  { id: 7, token: 'eJPY',  tier: 0, payment: 'eUSDC' },
  // eCNY - thanh toán eUSDC
  { id: 8, token: 'eCNY',  tier: 0, payment: 'eUSDC' },
  // eUSDC - thanh toán eUSDC
  { id: 9, token: 'eUSDC', tier: 0, payment: 'eUSDC' },
];

let ORDERS = [];

/**
 * Xây dựng ORDERS từ Forex rates + daily volume
 * available = số token còn có thể bán (tính từ daily cap)
 */
function rebuildOrders() {
  const rates = buildOrderRates();
  ORDERS = ORDER_TEMPLATE.map(tpl => {
    const rate         = rates[tpl.token][tpl.tier];
    const remainUsdt   = remainingDailyCapacity(tpl.id);
    // convert USDT cap → token unit  (eJPY: cap_usdt * rate, eCNY: cap_usdt * rate)
    const availTokens  = tpl.token === 'eUSDC'
      ? remainUsdt                             // eUSDC: 1:1 with USDT
      : parseFloat((remainUsdt * rate).toFixed(0));

    return {
      id:           tpl.id,
      token:        tpl.token,
      tier:         tpl.tier,
      rate,
      available:    availTokens,
      payment:      tpl.payment,
      dailyCapUsdt: DAILY_LIMIT_USDT,
      usedUsdt:     getDailyVolume(tpl.id).soldUsdt,
      sellerWallet: SELLER_KEYPAIR ? SELLER_KEYPAIR.publicKey.toBase58() : null,
      forexSource,
      forexBase:    FOREX_RATES[tpl.token],
      rateUpdatedAt: forexLastFetch || Date.now(),
    };
  });
}

// ═══════════════════════════════════════════════════
// PERSISTENT STORAGE
// ═══════════════════════════════════════════════════
let TX_HISTORY = [];

const DB_FILE_PATH = path.join(__dirname, 'db.json');
function saveDB() {
  try { fs.writeFileSync(DB_FILE_PATH, JSON.stringify({ TX_HISTORY, dailyVolume }, null, 2)); }
  catch(e) { console.error('[DB] Save error:', e.message); }
}
function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE_PATH)) { console.log('[DB] Fresh start.'); return; }
    const data = JSON.parse(fs.readFileSync(DB_FILE_PATH, 'utf8'));
    if (Array.isArray(data.TX_HISTORY)) TX_HISTORY = data.TX_HISTORY;
    if (data.dailyVolume)               dailyVolume = data.dailyVolume;
    console.log(`[DB] Loaded: ${TX_HISTORY.length} txs`);
  } catch(e) { console.error('[DB] Load error:', e.message); }
}

// ═══════════════════════════════════════════════════
// WALLET ENCRYPTION / DECRYPTION
// ═══════════════════════════════════════════════════
let SELLER_KEYPAIR = null;
const ALGORITHM   = 'aes-256-gcm';
const SALT_LEN    = 32;
const IV_LEN      = 16;
const AUTHTAG_LEN = 16;
const PBKDF2_HASH = 'sha512';
const KEY_LEN     = 32;

function decryptWalletFile(filePath, passphrase) {
  const raw     = fs.readFileSync(filePath, 'utf8');
  const payload = JSON.parse(raw);
  const buf     = Buffer.from(payload.data, 'base64');
  const salt    = buf.slice(0, SALT_LEN);
  const iv      = buf.slice(SALT_LEN, SALT_LEN + IV_LEN);
  const authTag = buf.slice(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + AUTHTAG_LEN);
  const cipher  = buf.slice(SALT_LEN + IV_LEN + AUTHTAG_LEN);
  const key     = crypto.pbkdf2Sync(passphrase, salt, payload.pbkdf2?.iter || 210000, KEY_LEN, PBKDF2_HASH);
  const dec     = crypto.createDecipheriv(ALGORITHM, key, iv);
  dec.setAuthTag(authTag);
  try {
    return Buffer.concat([dec.update(cipher), dec.final()]).toString('utf8');
  } catch {
    throw new Error('Sai mật khẩu hoặc file bị hỏng.');
  }
}

function keypairFromRaw(raw) {
  const trimmed = raw.trim();
  try {
    const arr = JSON.parse(trimmed);
    if (Array.isArray(arr) && arr.length === 64) return solanaWeb3.Keypair.fromSecretKey(Uint8Array.from(arr));
  } catch {}
  if (/^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(trimmed)) return solanaWeb3.Keypair.fromSecretKey(base58Decode(trimmed));
  if (/^[0-9a-fA-F]{128}$/.test(trimmed)) return solanaWeb3.Keypair.fromSecretKey(Buffer.from(trimmed, 'hex'));
  throw new Error('Định dạng private key không nhận dạng được.');
}

function promptPassphrase() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(WALLET_FILE)) {
      reject(new Error(`Không tìm thấy ${WALLET_FILE}. Chạy: node setup-wallet.js`));
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (attempt) => {
      if (attempt > 3) { rl.close(); reject(new Error('Sai mật khẩu 3 lần. Dừng.')); return; }
      process.stdout.write(`\n🔒 Nhập mật khẩu ví sàn (lần ${attempt}/3): `);
      let pass = '';
      const wasRaw = process.stdin.isTTY;
      if (wasRaw) process.stdin.setRawMode(true);
      const onData = (buf) => {
        const c = buf.toString('utf8');
        if (c === '\r' || c === '\n') {
          if (wasRaw) process.stdin.setRawMode(false);
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          try {
            const raw = decryptWalletFile(WALLET_FILE, pass);
            const kp  = keypairFromRaw(raw);
            if (SELLER_WALLET && kp.publicKey.toBase58() !== SELLER_WALLET) {
              rl.close();
              reject(new Error('Keypair không khớp SELLER_WALLET.'));
              return;
            }
            rl.close();
            resolve(kp);
          } catch(e) {
            console.error('   ⚠️  ' + e.message);
            ask(attempt + 1);
          }
        } else if (c === '\u0003') {
          process.exit();
        } else if (c === '\u007f') {
          pass = pass.slice(0, -1);
        } else {
          pass += c;
        }
      };
      if (wasRaw) {
        process.stdin.on('data', onData);
      } else {
        process.stdin.removeListener('data', onData);
        rl.question('', (ans) => {
          pass = ans.trim();
          try {
            const raw = decryptWalletFile(WALLET_FILE, pass);
            const kp  = keypairFromRaw(raw);
            if (SELLER_WALLET && kp.publicKey.toBase58() !== SELLER_WALLET) {
              rl.close(); reject(new Error('Keypair không khớp SELLER_WALLET.')); return;
            }
            rl.close(); resolve(kp);
          } catch(e) {
            console.error('   ⚠️  ' + e.message);
            ask(attempt + 1);
          }
        });
      }
    };
    ask(1);
  });
}

// ═══════════════════════════════════════════════════
// SOLANA RPC
// ═══════════════════════════════════════════════════
async function solanaRpc(method, params) {
  for (const rpc of SOLANA_RPCS) {
    try {
      const res = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        timeout: 30000,
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data.error) { console.warn(`[RPC] error from ${rpc}:`, data.error.message); continue; }
      return data;
    } catch(e) { console.warn(`[RPC] ${rpc} failed:`, e.message); }
  }
  return null;
}

function getConnection() {
  return new solanaWeb3.Connection(SOLANA_RPCS[0], 'confirmed');
}

function getATA(mintPubkey, ownerPubkey) {
  return splToken.getAssociatedTokenAddressSync(mintPubkey, ownerPubkey, false);
}

async function deliverTokensToBuyer(buyerAddress, tokenSymbol, amount) {
  if (!SELLER_KEYPAIR) throw new Error('Keypair ví sàn chưa được nạp.');
  const sellToken = SELL_TOKENS[tokenSymbol];
  if (!sellToken) throw new Error(`Token ${tokenSymbol} chưa được cấu hình.`);
  const conn      = getConnection();
  const mintKey   = new solanaWeb3.PublicKey(sellToken.mint);
  const buyerKey  = new solanaWeb3.PublicKey(buyerAddress);
  const sellerKey = SELLER_KEYPAIR.publicKey;
  const sellerATA = getATA(mintKey, sellerKey);
  const buyerATA  = getATA(mintKey, buyerKey);
  const instructions = [];
  const buyerATAInfo = await conn.getAccountInfo(buyerATA);
  if (!buyerATAInfo) {
    instructions.push(splToken.createAssociatedTokenAccountInstruction(
      buyerKey, buyerATA, buyerKey, mintKey
    ));
  }
  const rawAmt = BigInt(Math.round(amount * Math.pow(10, sellToken.decimals)));
  instructions.push(splToken.createTransferCheckedInstruction(
    sellerATA, mintKey, buyerATA, sellerKey, rawAmt, sellToken.decimals
  ));
  const tx = new solanaWeb3.Transaction().add(...instructions);
  return solanaWeb3.sendAndConfirmTransaction(conn, tx, [SELLER_KEYPAIR]);
}

// ═══════════════════════════════════════════════════
// SESSION MANAGER
// ═══════════════════════════════════════════════════
const sessions = new Map();
function registerSession(walletAddress, ws, walletType) {
  if (sessions.has(walletAddress)) {
    const old = sessions.get(walletAddress);
    if (old.ws !== ws && old.ws.readyState === WebSocket.OPEN) {
      old.ws.send(JSON.stringify({ type: 'KICKED', reason: 'Phiên mới từ thiết bị khác' }));
      old.ws.close();
    }
    sessions.set(walletAddress, { ws, connectedAt: Date.now(), walletType });
    return { ok: true };
  }
  if (sessions.size >= MAX_USERS) return { ok: false, reason: `Sàn đạt giới hạn ${MAX_USERS} người dùng.` };
  sessions.set(walletAddress, { ws, connectedAt: Date.now(), walletType });
  console.log(`[SESSION] +1 | ${walletAddress.slice(0,8)}... | ${sessions.size}/${MAX_USERS}`);
  broadcastUserCount();
  return { ok: true };
}
function removeSession(addr) {
  if (sessions.delete(addr)) {
    console.log(`[SESSION] -1 | ${addr?.slice(0,8)}... | ${sessions.size}/${MAX_USERS}`);
    broadcastUserCount();
  }
}

// ═══════════════════════════════════════════════════
// BROADCAST HELPERS
// ═══════════════════════════════════════════════════
function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const [, sess] of sessions)
    if (sess.ws.readyState === WebSocket.OPEN) sess.ws.send(s);
}
function broadcastUserCount() { broadcast({ type: 'USER_COUNT', count: sessions.size, max: MAX_USERS }); }
function broadcastOrderBook() { broadcast({ type: 'ORDER_BOOK', orders: ORDERS }); }
function broadcastTx(tx)      { broadcast({ type: 'NEW_TX', tx }); }
function broadcastDelivery(d) { broadcast({ type: 'DELIVERY', ...d }); }
function broadcastRates()     { broadcast({ type: 'FOREX_UPDATE', rates: FOREX_RATES, source: forexSource, updatedAt: forexLastFetch }); }

// ═══════════════════════════════════════════════════
// EXPRESS + HTTP + WS
// ═══════════════════════════════════════════════════
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.set('trust proxy', 1);

// ── CORS — cho phép GitHub Pages + Cloudflare Tunnel + localhost ──
const ALLOWED_ORIGINS = [
  'https://dexstablecoin.github.io',  // GitHub Pages production
  'http://localhost:8080',             // Local dev
  'http://localhost:3000',
  'http://127.0.0.1:8080',
];
function isAllowedOrigin(origin) {
  if (!origin) return true;                                        // curl / server-to-server
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (origin.endsWith('.trycloudflare.com')) return true;         // Cloudflare Quick Tunnels
  if (origin.endsWith('.cloudflareaccess.com')) return true;      // Cloudflare Access
  if (origin.endsWith('.cfargotunnel.com')) return true;          // Named tunnels
  return false;
}
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, ngrok-skip-browser-warning, CF-Access-Client-Id');
  res.setHeader('ngrok-skip-browser-warning', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname)));
// Serve mobile PWA tại /mobile/
app.use('/mobile', express.static(path.join(__dirname, 'mobile-dist')));

// ── GET /api/orders ──
app.get('/api/orders', (req, res) => {
  res.json({ ok: true, orders: ORDERS });
});

// ── GET /api/forex-rates ──
app.get('/api/forex-rates', (req, res) => {
  res.json({
    ok:        true,
    rates:     FOREX_RATES,
    source:    forexSource,
    updatedAt: forexLastFetch,
    maxBuyUsdt:   MAX_BUY_USDT,
    dailyLimitUsdt: DAILY_LIMIT_USDT,
  });
});

// ── GET /api/forex  (alias — frontend v4.3 fallback dùng endpoint này) ──
app.get('/api/forex', (req, res) => {
  res.json({
    ok:        true,
    rates:     FOREX_RATES,
    source:    forexSource,
    updatedAt: forexLastFetch,
  });
});

// ── GET /api/history ──
app.get('/api/history', (req, res) => {
  res.json({ ok: true, history: TX_HISTORY.slice(0, 20) });
});

// ── GET /api/status ──
app.get('/api/status', (req, res) => {
  res.json({
    ok:          true,
    connected:   sessions.size,
    max:         MAX_USERS,
    sellerReady: !!SELLER_KEYPAIR,
    forex:       { rates: FOREX_RATES, source: forexSource, updatedAt: forexLastFetch },
    limits:      { maxBuyUsdt: MAX_BUY_USDT, dailyLimitUsdt: DAILY_LIMIT_USDT },
  });
});

// ── GET /api/balance/:address ──
app.get('/api/balance/:address', async (req, res) => {
  const { address } = req.params;
  try {
    const solData   = await solanaRpc('getBalance', [address, { commitment: 'confirmed' }]);
    const SOL       = (solData?.result?.value || 0) / 1e9;
    const tokenData = await solanaRpc('getTokenAccountsByOwner', [
      address,
      { programId: TOKEN_PROGRAM_ID.toBase58() },
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ]);
    const balances = { USDT: 0, USDC: 0, eUSDC: 0 };
    (tokenData?.result?.value || []).forEach(acc => {
      const info = acc?.account?.data?.parsed?.info;
      if (!info) return;
      const amt = parseFloat(info.tokenAmount?.uiAmountString || '0');
      if (info.mint === PAYMENT_TOKENS.USDT.mint)  balances.USDT  = amt;
      if (info.mint === PAYMENT_TOKENS.USDC.mint)  balances.USDC  = amt;
      if (info.mint === PAYMENT_TOKENS.eUSDC.mint) balances.eUSDC = amt;
    });
    res.json({ ok: true, SOL, ...balances });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════
// POST /api/calc-order
// Tính toán lệnh mua — TOÀN BỘ validation ở đây
// ═══════════════════════════════════════════════════
app.post('/api/calc-order', (req, res) => {
  const { token, amount, payment } = req.body;
  if (!token || !amount || !payment)
    return res.status(400).json({ ok: false, error: 'Thiếu tham số: token, amount, payment' });

  const buyAmount = parseFloat(amount);
  if (isNaN(buyAmount) || buyAmount <= 0)
    return res.status(400).json({ ok: false, error: 'Số lượng không hợp lệ' });

  // Tìm lệnh bán phù hợp (tỷ giá thấp nhất)
  const best = ORDERS
    .filter(o => o.token === token && o.payment === payment && o.available > 0)
    .sort((a, b) => a.rate - b.rate)[0];

  if (!best)
    return res.json({ ok: false, error: 'Không có lệnh bán phù hợp' });

  // ── Kiểm tra giới hạn mua tối đa MAX_BUY_USDT ──
  // cost = số USDT/USDC/eUSDC phải trả
  const rawCost    = buyAmount / best.rate;
  const maxTokens  = MAX_BUY_USDT * best.rate; // số token tương đương MAX_BUY_USDT
  if (rawCost > MAX_BUY_USDT + 0.001) {
    return res.json({
      ok:    false,
      error: `Lệnh mua vượt giới hạn tối đa ${MAX_BUY_USDT} USDT/giao dịch`,
      maxBuyTokens:  parseFloat(maxTokens.toFixed(0)),
      maxBuyUsdt:    MAX_BUY_USDT,
    });
  }

  // ── Kiểm tra daily volume còn lại ──
  const remaining = remainingDailyCapacity(best.id);
  const remainingTokens = best.token === 'eUSDC' ? remaining : parseFloat((remaining * best.rate).toFixed(0));
  if (buyAmount > best.available) {
    return res.json({
      ok:    false,
      error: `Khối lượng không đủ. Còn ${best.available} ${token} hôm nay`,
      available: best.available,
      dailyCapUsdt: DAILY_LIMIT_USDT,
      usedUsdt:     best.usedUsdt,
    });
  }

  const actualBuy  = Math.min(buyAmount, best.available);
  const cost       = parseFloat((actualBuy / best.rate).toFixed(6));
  const sellerWallet = SELLER_KEYPAIR ? SELLER_KEYPAIR.publicKey.toBase58() : null;

  res.json({
    ok:           true,
    token,
    payment,
    buyAmount:    actualBuy,
    cost,
    rate:         best.rate,
    orderId:      best.id,
    maxCanBuy:    Math.min(best.available, maxTokens),
    maxBuyUsdt:   MAX_BUY_USDT,
    sellerWallet,
    forexBase:    FOREX_RATES[token],
    forexSource,
    rateUpdatedAt: forexLastFetch,
  });
});

// ═══════════════════════════════════════════════════
// POST /api/prepare-payment-tx
// Build tx thanh toán cho buyer ký — backend kiểm tra lại
// ═══════════════════════════════════════════════════
app.post('/api/prepare-payment-tx', async (req, res) => {
  const { orderId, buyAmount, buyerAddress } = req.body;
  if (!orderId || !buyAmount || !buyerAddress)
    return res.status(400).json({ ok: false, error: 'Thiếu tham số' });

  const order = ORDERS.find(o => o.id === parseInt(orderId));
  if (!order) return res.status(404).json({ ok: false, error: 'Lệnh không tồn tại' });
  if (!SELLER_KEYPAIR) return res.status(503).json({ ok: false, error: 'Ví sàn chưa được nạp keypair.' });

  const bAmt = parseFloat(buyAmount);

  // ── Validate lại: giới hạn mua ──
  const cost = bAmt / order.rate;
  if (cost > MAX_BUY_USDT + 0.001)
    return res.status(400).json({ ok: false, error: `Vượt giới hạn mua tối đa ${MAX_BUY_USDT} USDT/giao dịch` });

  // ── Validate lại: daily volume ──
  const remaining = remainingDailyCapacity(order.id);
  const remainingTokens = order.token === 'eUSDC' ? remaining : parseFloat((remaining * order.rate).toFixed(0));
  if (bAmt > remainingTokens + 0.001)
    return res.status(400).json({ ok: false, error: `Vượt khối lượng giới hạn ngày. Còn ${remainingTokens.toFixed(0)} ${order.token}` });

  const payToken = PAYMENT_TOKENS[order.payment];
  if (!payToken) return res.status(400).json({ ok: false, error: 'Token thanh toán không hợp lệ' });

  try {
    const conn      = getConnection();
    const mintKey   = new solanaWeb3.PublicKey(payToken.mint);
    const buyerKey  = new solanaWeb3.PublicKey(buyerAddress);
    const sellerKey = SELLER_KEYPAIR.publicKey;
    const buyerATA  = getATA(mintKey, buyerKey);
    const sellerATA = getATA(mintKey, sellerKey);

    // Tạo ATA còn thiếu
    const ataSetupIxs = [];
    const sellerATAInfo = await conn.getAccountInfo(sellerATA);
    if (!sellerATAInfo) {
      ataSetupIxs.push(splToken.createAssociatedTokenAccountInstruction(
        sellerKey, sellerATA, sellerKey, mintKey
      ));
    }
    const buyerATAInfo = await conn.getAccountInfo(buyerATA);
    if (!buyerATAInfo) {
      ataSetupIxs.push(splToken.createAssociatedTokenAccountInstruction(
        sellerKey, buyerATA, buyerKey, mintKey
      ));
    }
    if (ataSetupIxs.length > 0) {
      const setupTx = new solanaWeb3.Transaction().add(...ataSetupIxs);
      setupTx.feePayer = sellerKey;
      const { blockhash: bh } = await conn.getLatestBlockhash('confirmed');
      setupTx.recentBlockhash = bh;
      await solanaWeb3.sendAndConfirmTransaction(conn, setupTx, [SELLER_KEYPAIR]);
      console.log(`[PREPARE] ATA setup tx confirmed.`);
    }

    const rawAmt = BigInt(Math.round(cost * Math.pow(10, payToken.decimals)));
    const transferIx = splToken.createTransferCheckedInstruction(
      buyerATA, mintKey, sellerATA, buyerKey, rawAmt, payToken.decimals
    );

    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
    const tx = new solanaWeb3.Transaction().add(transferIx);
    tx.feePayer        = buyerKey;
    tx.recentBlockhash = blockhash;

    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    console.log(`[PREPARE] TX ready: buyer=${buyerAddress.slice(0,8)}... cost=${cost.toFixed(6)} ${order.payment}`);

    res.json({
      ok:                  true,
      serializedTx:        Buffer.from(serialized).toString('base64'),
      blockhash,
      lastValidBlockHeight,
      cost:                parseFloat(cost.toFixed(6)),
      orderId:             order.id,
      buyAmount:           bAmt,
    });
  } catch(e) {
    console.error('[PREPARE] Error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════
// POST /api/broadcast-tx
// Verify on-chain → cập nhật volume → giao token
// ═══════════════════════════════════════════════════
app.post('/api/broadcast-tx', async (req, res) => {
  const { serializedTx, orderId, buyAmount, buyerAddress } = req.body;
  if (!serializedTx || !orderId || !buyAmount || !buyerAddress)
    return res.status(400).json({ ok: false, error: 'Thiếu tham số' });

  const order = ORDERS.find(o => o.id === parseInt(orderId));
  if (!order) return res.status(404).json({ ok: false, error: 'Lệnh không tồn tại' });

  // ── Kiểm tra lần cuối trước khi broadcast ──
  const bAmt = parseFloat(buyAmount);
  const cost = bAmt / order.rate;
  if (cost > MAX_BUY_USDT + 0.001)
    return res.status(400).json({ ok: false, error: `Vượt giới hạn mua tối đa ${MAX_BUY_USDT} USDT` });

  const remaining = remainingDailyCapacity(order.id);
  const remainingTokens = order.token === 'eUSDC' ? remaining : (remaining * order.rate);
  if (bAmt > remainingTokens + 0.001)
    return res.status(400).json({ ok: false, error: 'Vượt khối lượng giới hạn ngày' });

  try {
    // 1. Broadcast
    const txBuffer = Buffer.from(serializedTx, 'base64');
    const broadcastData = await solanaRpc('sendTransaction', [
      txBuffer.toString('base64'),
      { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed' }
    ]);
    if (!broadcastData?.result) throw new Error(broadcastData?.error?.message || 'Broadcast thất bại');
    const signature = broadcastData.result;
    console.log(`[BROADCAST] TX sent: ${signature.slice(0,12)}...`);

    // 2. Chờ xác nhận
    let confirmed = false;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const statusData = await solanaRpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
      const status = statusData?.result?.value?.[0];
      if (status?.err) throw new Error('Giao dịch thất bại: ' + JSON.stringify(status.err));
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
        confirmed = true; break;
      }
    }
    if (!confirmed) throw new Error('Giao dịch chưa được xác nhận sau 60 giây.');

    // 3. Verify on-chain
    const payToken = PAYMENT_TOKENS[order.payment];
    const txData   = await solanaRpc('getTransaction', [signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
    if (!txData?.result) throw new Error('Không đọc được chi tiết giao dịch.');
    if (txData.result.meta?.err) throw new Error('Giao dịch có lỗi on-chain.');

    const sellerPublicKey = SELLER_KEYPAIR?.publicKey.toBase58();
    const preBals  = txData.result.meta?.preTokenBalances  || [];
    const postBals = txData.result.meta?.postTokenBalances || [];
    let verified = false, actualAmount = 0;
    for (const post of postBals) {
      if (post.mint !== payToken.mint) continue;
      const pre   = preBals.find(p => p.accountIndex === post.accountIndex);
      const delta = (post.uiTokenAmount?.uiAmount || 0) - (pre?.uiTokenAmount?.uiAmount || 0);
      if (delta > 0 && post.owner === sellerPublicKey) { verified = true; actualAmount = delta; break; }
    }
    if (!verified) throw new Error('Không tìm thấy token transfer hợp lệ đến ví sàn.');

    const expectedCost = parseFloat(cost.toFixed(6));
    const tolerance    = Math.max(expectedCost * 0.01, 0.001);
    if (Math.abs(actualAmount - expectedCost) > tolerance)
      throw new Error(`Số tiền không khớp. Mong đợi: ${expectedCost}, thực tế: ${actualAmount}`);

    console.log(`[VERIFY] ✅ ${signature.slice(0,10)}... | ${actualAmount} ${order.payment} → seller`);

    // 4. Chống replay
    if (TX_HISTORY.some(h => h.txHash === signature))
      return res.status(409).json({ ok: false, error: 'Giao dịch đã xử lý.' });

    // 5. Cập nhật daily volume
    const costUsdt = order.token === 'eUSDC' ? bAmt : cost; // USDT-equivalent
    addDailyVolume(order.id, costUsdt);

    // 6. Lưu TX history
    const tx = {
      token: order.token, amount: bAmt,
      cost: parseFloat(actualAmount.toFixed(4)), payment: order.payment,
      addr: buyerAddress.slice(0,5)+'...'+buyerAddress.slice(-4),
      buyerAddress, txHash: signature, time: Date.now(),
      deliveryStatus: 'pending', deliverySig: null,
      rate: order.rate, forexBase: order.forexBase, forexSource,
    };
    TX_HISTORY.unshift(tx);
    if (TX_HISTORY.length > 100) TX_HISTORY.pop();

    // Rebuild orders với volume mới
    rebuildOrders();
    saveDB();
    broadcastOrderBook();
    broadcastTx(tx);

    res.json({ ok: true, signature, actualAmount });

    // 7. Auto-deliver (async)
    setImmediate(async () => {
      try {
        await new Promise(r => setTimeout(r, 3000));
        const sig = await deliverTokensToBuyer(buyerAddress, order.token, bAmt);
        tx.deliveryStatus = 'success';
        tx.deliverySig    = sig;
        saveDB();
        broadcastDelivery({ txHash: signature, deliverySig: sig, status: 'success', token: order.token, amount: bAmt, buyerAddress });
        console.log(`[DELIVER] 🎉 ${bAmt} ${order.token} → ${buyerAddress.slice(0,8)}...`);
      } catch(e) {
        console.error(`[DELIVER] ❌ ${e.message}`);
        tx.deliveryStatus = 'failed'; tx.deliveryError = e.message;
        saveDB();
        broadcastDelivery({ txHash: signature, status: 'failed', error: e.message, token: order.token, amount: bAmt, buyerAddress });
      }
    });

  } catch(e) {
    console.error('[BROADCAST] Error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════
// WEBSOCKET
// ═══════════════════════════════════════════════════
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({
    type: 'INIT',
    orders: ORDERS,
    history: TX_HISTORY.slice(0, 10),
    userCount: sessions.size,
    max: MAX_USERS,
    forex: { rates: FOREX_RATES, source: forexSource, updatedAt: forexLastFetch },
    limits: { maxBuyUsdt: MAX_BUY_USDT, dailyLimitUsdt: DAILY_LIMIT_USDT },
  }));
  let addr = null;
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'REGISTER') {
        addr = msg.address;
        ws.send(JSON.stringify({ type: 'REGISTER_RESULT', ...registerSession(addr, ws, msg.walletType) }));
      }
      if (msg.type === 'PING') ws.send(JSON.stringify({ type: 'PONG', time: Date.now() }));
    } catch {}
  });
  ws.on('close', () => { if (addr) removeSession(addr); });
  ws.on('error', e  => { console.warn('[WS]', e.message); });
});

// ═══════════════════════════════════════════════════
// PERIODIC TASKS
// ═══════════════════════════════════════════════════
async function periodicForexUpdate() {
  const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
  console.log(`[FOREX] ⏰ Scheduled refresh at ${ts}`);
  await fetchForexRates();
  rebuildOrders();
  broadcastOrderBook();
  broadcastRates();
}

// ═══════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════
async function boot() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   StableX DEX Backend v4  (Forex-Linked Rates)  ║');
  console.log('╚══════════════════════════════════════════════════╝');

  loadDB();
  loadDailyVolume();

  // Fetch giá Forex ngay khi khởi động
  console.log('\n[FOREX] Đang lấy tỷ giá từ Forex...');
  await fetchForexRates();
  rebuildOrders();

  console.log(`[ORDERS] Đã xây dựng ${ORDERS.length} lệnh bán từ giá Forex`);
  ORDERS.forEach(o => console.log(`   #${o.id} ${o.token}/${o.payment} rate=${o.rate} avail=${o.available}`));

  // Nạp keypair ví
  if (!fs.existsSync(WALLET_FILE)) {
    console.warn('\n⚠️  wallet.enc không tồn tại. Chạy: node setup-wallet.js\n');
  } else {
    try {
      SELLER_KEYPAIR = await promptPassphrase();
      console.log(`\n✅ Keypair loaded: ${SELLER_KEYPAIR.publicKey.toBase58()}`);
      rebuildOrders(); // cập nhật sellerWallet vào orders
    } catch(e) {
      console.error('\n❌ Không nạp được keypair:', e.message);
    }
  }

  // Tự động cập nhật Forex mỗi PRICE_REFRESH_MS
  setInterval(periodicForexUpdate, PRICE_REFRESH_MS);
  console.log(`[FOREX] Auto-refresh mỗi ${PRICE_REFRESH_MS / 60000} phút (${PRICE_REFRESH_MS/1000}s)`);

  // Reset daily volume lúc 00:00 UTC
  const msToMidnightUTC = () => {
    const now  = new Date();
    const next = new Date(now);
    next.setUTCDate(now.getUTCDate() + 1);
    next.setUTCHours(0, 0, 5, 0); // 00:00:05 UTC
    return next.getTime() - now.getTime();
  };
  const scheduleMidnightReset = () => {
    setTimeout(() => {
      console.log('[VOL] 🔄 Midnight reset — xóa daily volume');
      dailyVolume = {};
      saveDailyVolume();
      rebuildOrders();
      broadcastOrderBook();
      scheduleMidnightReset(); // lên lịch lại cho ngày sau
    }, msToMidnightUTC());
  };
  scheduleMidnightReset();
  console.log(`[VOL] Midnight reset lên lịch. Còn ${Math.round(msToMidnightUTC()/3600000)} giờ`);

  server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log(`🚀 Server: http://localhost:${PORT}`);
    console.log(`   Max users       : ${MAX_USERS}`);
    console.log(`   Daily volume cap: ${DAILY_LIMIT_USDT} USDT/order/ngày`);
    console.log(`   Max buy/tx      : ${MAX_BUY_USDT} USDT`);
    console.log(`   Forex source    : ${forexSource}`);
    console.log(`   Keypair         : ${SELLER_KEYPAIR ? SELLER_KEYPAIR.publicKey.toBase58() : '⚠️  chưa nạp'}`);
    console.log('');
    console.log('── Expose ra Internet ─────────────────────────────');
    console.log(`   ngrok http ${PORT}`);
    console.log(`   cloudflared tunnel --url http://localhost:${PORT}`);
    console.log('───────────────────────────────────────────────────');
  });
}

boot().catch(e => { console.error('Boot failed:', e); process.exit(1); });
