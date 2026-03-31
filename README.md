# StableX DEX — Stablecoin Exchange on Solana

> Decentralized P2P stablecoin exchange · Zero fees · Forex-linked rates · Solana Mainnet

![Status](https://img.shields.io/badge/status-live-brightgreen)
![Chain](https://img.shields.io/badge/chain-Solana-9945ff)
![Fee](https://img.shields.io/badge/fee-0%25-00d4aa)

**Live:** https://dexstablecoin.github.io/DEXStablecoin.com/

---

## Tổng quan

StableX DEX là sàn giao dịch P2P phi tập trung chuyên về stablecoin fiat:

| Token | Pegged to | Thanh toán |
|-------|-----------|------------|
| eJPY  | Yên Nhật (JPY) | USDT / eUSDC |
| eCNY  | Nhân dân tệ (CNY) | USDT / eUSDC |
| eUSDC | USD | USDC / eUSDC |

- **Giá tỷ giá** lấy live từ Forex (open.er-api.com) — cập nhật mỗi 30 phút
- **WebSocket** push real-time tới frontend
- **Auto-delivery** token sau khi xác nhận on-chain
- **Giới hạn:** 1,000 USDT/giao dịch · 50,000 USDT/ngày

---

## Kiến trúc hệ thống

```
GitHub Pages (frontend)
        │
        │  WebSocket + HTTP API
        ▼
Cloudflare Tunnel (trycloudflare.com)
        │
        │  localhost:8080
        ▼
server.js (Node.js · máy local)
        │
        ├── Forex API (open.er-api.com)
        ├── Solana RPC (mainnet-beta)
        └── SQLite / db.json
```

---

## Cấu trúc thư mục

```
DEX_Stablecoin_Project/     ← Backend (chạy local, KHÔNG push GitHub)
├── server.js               ← Express + WebSocket server
├── db.json                 ← Lịch sử giao dịch
├── daily_volume.json       ← Volume theo ngày
├── wallet.enc              ← Keypair ví sàn (mã hóa AES-256)
├── setup-wallet.js         ← Tool tạo wallet.enc
└── node_modules/

DEXStablecoin.com/          ← Frontend repo (GitHub Pages)
├── index.html              ← Toàn bộ frontend
├── server.js               ← Copy từ backend (tham khảo)
├── mobile.html             ← Mobile PWA
└── README.md
```

---

## Cài đặt & Chạy

### Yêu cầu

- Node.js 18+
- npm
- cloudflared

### Bước 1 — Cài dependencies

```bash
cd ~/DEX_Stablecoin_Project
npm install
```

### Bước 2 — Tạo ví sàn (chỉ làm 1 lần)

```bash
node setup-wallet.js
```

### Bước 3 — Chạy hàng ngày

**Terminal 1 — Backend server:**
```bash
cd ~/DEX_Stablecoin_Project
node server.js
# Nhập mật khẩu ví khi được hỏi
```

Xác nhận server OK:
```
✅ Keypair loaded: ETVg4M1...
[FOREX] ✅ open.er-api.com → eJPY=159.68, eCNY=6.92
🚀 Server: http://localhost:8080
```

**Terminal 2 — Cloudflare Tunnel:**
```bash
cloudflared tunnel --url http://localhost:8080 2>&1 | grep trycloudflare
```

Copy URL xuất hiện, ví dụ:
```
https://bosnia-designs-desert-pubs.trycloudflare.com
```

**Terminal 3 — Cập nhật URL và deploy:**
```bash
# Thay URL_MỚI bằng URL vừa copy ở trên
sed -i "s|https://.*trycloudflare\.com|https://URL_MỚI|g" ~/DEXStablecoin.com/index.html

cd ~/DEXStablecoin.com
git add index.html
git commit -m "fix: update tunnel URL"
git push origin main
```

Chờ **1-2 phút** → vào https://dexstablecoin.github.io/DEXStablecoin.com/

---

## API Endpoints

| Method | Endpoint | Mô tả |
|--------|----------|-------|
| GET | `/api/status` | Trạng thái server |
| GET | `/api/orders` | Danh sách lệnh bán |
| GET | `/api/forex` | Tỷ giá Forex hiện tại |
| GET | `/api/forex-rates` | Tỷ giá + giới hạn giao dịch |
| GET | `/api/history` | 20 giao dịch gần nhất |
| GET | `/api/balance/:address` | Số dư ví Solana |
| POST | `/api/calc-order` | Tính toán lệnh mua |
| POST | `/api/prepare-payment-tx` | Tạo transaction thanh toán |
| POST | `/api/broadcast-tx` | Broadcast + xác nhận on-chain |

---

## WebSocket Events

| Event | Hướng | Mô tả |
|-------|-------|-------|
| `INIT` | Server → Client | Dữ liệu khởi tạo (orders, forex, history) |
| `ORDER_BOOK` | Server → Client | Cập nhật order book |
| `FOREX_UPDATE` | Server → Client | Tỷ giá mới |
| `NEW_TX` | Server → Client | Giao dịch mới |
| `DELIVERY` | Server → Client | Trạng thái giao token |
| `USER_COUNT` | Server → Client | Số người dùng online |
| `REGISTER` | Client → Server | Đăng ký session ví |
| `PING` | Client → Server | Keepalive |

---

## Token Addresses (Solana Mainnet)

| Token | Mint Address |
|-------|-------------|
| eJPY | `HwbwHTKkze4hzF4SSz1Tj3cAb5f2qXd2e8gbFTPXUcj3` |
| eCNY | `ABetScri1grGy52wxmq6PGC9kG9B7Z6PVx74B4DQxzUt` |
| eUSDC | `6VwnrGyk8XutR8ZM444Lyq8geo2hAcAtB7vMXf7LHTAJ` |
| USDT | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` |
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |

---

## Nguồn dữ liệu Forex

Server tự động thử các nguồn theo thứ tự ưu tiên:

1. **open.er-api.com** — Free, không cần API key
2. **fxratesapi.com** — Fallback
3. **fawazahmed0/currency-api** — CDN fallback
4. Hardcode fallback (eJPY=150, eCNY=7.2)

Cập nhật mỗi **30 phút**. Reset daily volume lúc **00:00 UTC**.

---

## Roadmap

| Phase | Trạng thái | Nội dung |
|-------|-----------|---------|
| Phase 1 | ✅ Live | DEX Web3, Solana, eJPY/eCNY/eUSDC, phí 0% |
| Phase 2 | 🔜 Sắp tới | Open seller listing, Liquidity pool, Limit orders |
| Phase 3 | 📋 Planned | Ethereum bridge, BNB Chain, Cross-chain swap |
| Phase 4 | 🔮 Future | Native token SBX, DAO governance, Mobile app |

---

## Bảo mật

- Private key ví sàn được mã hóa **AES-256-GCM** với PBKDF2 (210,000 iterations)
- Không bao giờ commit `wallet.enc`, `db.json`, `.ngrok_token` lên GitHub
- File `.gitignore` đã loại trừ các file nhạy cảm

---

## License

MIT © StableX DEX Team
