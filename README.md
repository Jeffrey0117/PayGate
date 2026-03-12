# PayGate

CloudPipe 生態系的統一付款閘道。接收付款 Webhook、記錄購買狀態、供所有產品查詢「付了沒」。

```
┌──────────┐    ┌──────────┐    ┌──────────┐
│ 金流平台  │───>│ PayGate  │───>│ Mailer   │  確認信
│ (PayUni) │    │ (收銀台) │───>│ Telegram │  通知
└──────────┘    └──────────┘    └──────────┘
                     │
              ┌──────┴──────┐
              │  任何產品    │
              │  GET /check  │  「這用戶付了沒？」
              └─────────────┘
```

**定位**：生態系的「收銀台」。所有產品（Pokkit、AutoCard、ReelScript...）共用一個付款狀態資料庫，不需要各自串金流。金流平台付款成功後打一次 Webhook，PayGate 就記錄完畢，任何產品都能用一行 API 查詢。

## 功能

- 接收付款 Webhook（支援 Classroo / PayUni 等金流來源）
- order_id 冪等性檢查（同一筆訂單不重複入庫）
- SQLite 購買記錄（WAL mode, better-sqlite3）
- 公開查詢端點 `/api/purchases/check`（免 auth，不洩漏敏感資料）
- 付款成功自動發確認信（透過 Mailer）+ Telegram 通知
- 手動開通 `/api/activate`（管理員用）
- 支援到期時間（`expires_at`），自動判斷過期

## 快速啟動

```bash
npm install
cp .env.example .env   # 填入 token
PORT=4019 node server.js
```

## 環境變數

| 變數 | 必填 | 說明 |
|------|------|------|
| `PORT` | 否 | 伺服器端口（預設 4019）|
| `PAYGATE_TOKEN` | 是 | 管理 API 的 Bearer token |
| `PAYGATE_WEBHOOK_SECRET` | 是 | Webhook 驗證 token |

## API

### `GET /api/health`

```bash
curl http://localhost:4019/api/health
```

```json
{ "status": "ok", "service": "paygate", "totalPurchases": 42 }
```

### `POST /api/webhook`

金流平台付款成功後呼叫。自動發確認信 + Telegram 通知。

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

重複的 `order_id` 會回傳 `{ "duplicate": true }`，不重複入庫。

### `GET /api/purchases/check?email=&product=`

**公開端點**（不需 auth）。任何產品都能呼叫來確認用戶是否付費。

```bash
curl "http://localhost:4019/api/purchases/check?email=buyer@example.com&product=pokkit-pro"
```

```json
{ "active": true, "plan": "lifetime", "expires_at": null }
```

或：

```json
{ "active": false }
```

### `GET /api/purchases/:email`

列出某 email 的所有購買記錄（需 auth）。

```bash
curl http://localhost:4019/api/purchases/buyer@example.com \
  -H "Authorization: Bearer $PAYGATE_TOKEN"
```

### `POST /api/activate`

手動開通購買（管理員用途，不經過金流）。

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

## 跨服務呼叫

其他子專案透過 CloudPipe Gateway SDK 查詢付費狀態：

```javascript
const gw = require('../../sdk/gateway');

// 檢查用戶是否有效付費
const result = await gw.call('paygate_check', {
  email: 'user@example.com',
  product: 'my-product',
});

if (!result.active) {
  return res.status(402).json({ error: '請先購買此產品' });
}
```

## 資料庫

SQLite（`data/paygate.db`），WAL mode，`better-sqlite3`。

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
  expires_at  TEXT,                 -- NULL = 永久有效
  source      TEXT DEFAULT '',      -- payuni, manual, ...
  order_id    TEXT,                 -- 冪等性用
  raw_payload TEXT,                 -- Webhook 原始 JSON
  created_at  TEXT DEFAULT (datetime('now'))
);
```

索引：`email`、`product_id`、`order_id`。

## 技術架構

- **Runtime**: Node.js, CJS (`require` / `module.exports`)
- **HTTP**: Node 內建 `http` 模組（無框架）
- **DB**: `better-sqlite3`（WAL mode）
- **通知**: fire-and-forget（不阻塞 Webhook 回應）
  - 確認信：透過 `sdk/gateway.js` 呼叫 Mailer
  - Telegram：透過 `sdk/telegram.js` 發送
- **程式碼**: `server.js`（281 行）+ `db.js`（43 行）

## 授權

MIT
