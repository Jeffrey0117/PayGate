# PayGate

> **[中文版 README](README.zh-TW.md)**

Unified payment gateway for the [CloudPipe](https://github.com/Jeffrey0117/CloudPipe) ecosystem. Receives payment webhooks, records purchase status, and lets any product check "has this user paid?"

```
┌──────────┐    ┌──────────┐    ┌──────────┐
│ Payment  │───>│ PayGate  │───>│  Mailer  │  confirmation
│ Provider │    │ (gateway)│───>│ Telegram │  notification
└──────────┘    └──────────┘    └──────────┘
                     │
              ┌──────┴──────┐
              │ Any product  │
              │ GET /check   │  "has this user paid?"
              └─────────────┘
```

All products (Pokkit, AutoCard, ReelScript...) share a single purchase database — no per-product payment integration needed. After the payment provider fires a webhook once, any product can check purchase status with a single API call.

## Features

- Payment webhook receiver (supports Classroo / PayUni and other providers)
- `order_id` idempotency check (no duplicate inserts)
- SQLite purchase records (WAL mode, better-sqlite3)
- Public check endpoint `/api/purchases/check` (no auth, no sensitive data leaks)
- Auto-sends confirmation email (via Mailer) + Telegram notification on purchase
- Manual activation `/api/activate` (admin use)
- Expiration support (`expires_at`) with automatic expiry checks

## Quick Start

```bash
npm install
cp .env.example .env   # fill in tokens
PORT=4019 node server.js
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 4019) |
| `PAYGATE_TOKEN` | Yes | Bearer token for admin API |
| `PAYGATE_WEBHOOK_SECRET` | Yes | Bearer token for webhook auth |

## API

### `GET /api/health`

```bash
curl http://localhost:4019/api/health
```

```json
{ "status": "ok", "service": "paygate", "totalPurchases": 42 }
```

### `POST /api/webhook`

Called by the payment provider after successful payment. Automatically sends a confirmation email and Telegram notification.

```bash
curl -X POST http://localhost:4019/api/webhook \
  -H "Authorization: Bearer $PAYGATE_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "buyer@example.com",
    "product_id": "pokkit-pro",
    "order_id": "ORD-20250310-001",
    "plan": "lifetime",
    "amount": 990,
    "currency": "TWD",
    "source": "payuni"
  }'
```

```json
{ "success": true, "purchaseId": "pur_a1b2c3d4e5f6g7h8" }
```

Duplicate `order_id` returns `{ "duplicate": true }` without creating a new record.

### `GET /api/purchases/check?email=&product=`

**Public endpoint** (no auth). Any product can call this to verify if a user has paid.

```bash
curl "http://localhost:4019/api/purchases/check?email=buyer@example.com&product=pokkit-pro"
```

```json
{ "active": true, "plan": "lifetime", "expires_at": null }
```

Or:

```json
{ "active": false }
```

### `GET /api/purchases/:email`

List all purchases for an email (requires auth).

```bash
curl http://localhost:4019/api/purchases/buyer@example.com \
  -H "Authorization: Bearer $PAYGATE_TOKEN"
```

### `POST /api/activate`

Manually activate a purchase (admin use, no payment webhook needed).

```bash
curl -X POST http://localhost:4019/api/activate \
  -H "Authorization: Bearer $PAYGATE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "vip@example.com",
    "product_id": "reelscript-pro",
    "plan": "yearly",
    "expires_at": "2026-03-10T00:00:00Z"
  }'
```

## Cross-Service Usage

Other sub-projects check purchase status via the CloudPipe Gateway SDK:

```javascript
const gw = require('../../sdk/gateway');

// Check if user has an active purchase
const result = await gw.call('paygate_check', {
  email: 'user@example.com',
  product: 'my-product',
});

if (!result.active) {
  return res.status(402).json({ error: 'Please purchase this product first' });
}
```

## Database

SQLite (`data/paygate.db`), WAL mode, `better-sqlite3`.

```sql
CREATE TABLE purchases (
  id          TEXT PRIMARY KEY,     -- pur_xxxxxxxxxxxxxxxx
  email       TEXT NOT NULL,
  product_id  TEXT NOT NULL,
  plan        TEXT DEFAULT '',
  status      TEXT DEFAULT 'active',
  amount      INTEGER DEFAULT 0,
  currency    TEXT DEFAULT 'TWD',
  paid_at     TEXT DEFAULT (datetime('now')),
  expires_at  TEXT,                 -- NULL = never expires
  source      TEXT DEFAULT '',      -- payuni, manual, ...
  order_id    TEXT,                 -- idempotency key
  raw_payload TEXT,                 -- raw webhook JSON
  created_at  TEXT DEFAULT (datetime('now'))
);
```

Indexes: `email`, `product_id`, `order_id`.

## Architecture

- **Runtime**: Node.js, CJS (`require` / `module.exports`)
- **HTTP**: Node built-in `http` module (no framework)
- **DB**: `better-sqlite3` (WAL mode)
- **Notifications**: Fire-and-forget (non-blocking)
  - Confirmation email: via `sdk/gateway.js` calling Mailer
  - Telegram: via `sdk/telegram.js`
- **Source**: `server.js` (281 lines) + `db.js` (43 lines)

## License

MIT
