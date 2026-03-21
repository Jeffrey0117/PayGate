# PayGate

> **[中文版 README](README.zh-TW.md)**

Unified payment + subscription gateway for the [CloudPipe](https://github.com/Jeffrey0117/CloudPipe) ecosystem. Any product can add paid tiers in minutes — just seed plans and call `check_subscription`.

```
┌──────────┐    ┌──────────┐    ┌──────────┐
│ Payment  │───>│ PayGate  │───>│  Mailer  │  confirmation
│ Provider │    │ (webhook)│───>│ Telegram │  notification
└──────────┘    └──────────┘    └──────────┘
                     │
              ┌──────┴──────┐
              │ Any product  │
              │ check_sub    │  "tier? quotas? active?"
              └─────────────┘
```

## Features

- **Purchases**: Webhook receiver (PayUNi / Classroo), idempotent via `order_id`
- **Subscriptions**: Plan-based tiers with quotas, auto-extend on repeat purchase
- **Outgoing Webhooks**: HMAC-SHA256 signed events to products (`subscription.activated/expired/cancelled`)
- **PayUNi Integration**: AES-256-GCM decrypt + CheckCode verify, periodic payment support
- Auto-sends confirmation email (Mailer) + Telegram notification
- Public check endpoints (no auth, no sensitive data leaks)
- Daily expiry cron via CloudPipe scheduler

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
| `PAYGATE_WEBHOOK_SECRET` | Yes | Bearer token for generic webhook auth |
| `PAYUNI_HASH_KEY` | For PayUNi | PayUNi AES key |
| `PAYUNI_HASH_IV` | For PayUNi | PayUNi AES IV |

---

## Adding Subscriptions to a New Product (Integration Guide)

**Proven pattern from LurlHub integration (30K+ users, production since 2026-03).**

### Step 1: Seed Plans in PayGate

Create `data/seed-{product}.js`:

```javascript
const { getDb } = require('../db');
const { upsertPlan } = require('../plans');

getDb();

const plans = [
  {
    id: 'myapp:basic:monthly',
    product: 'myapp',
    tier: 'basic',
    display_name: 'Basic Monthly',
    billing_cycle: 'monthly',  // monthly | yearly | lifetime
    price: 299,
    quotas: { monthlyQuota: 20, maxStorage: 1073741824 },
    checkout_url: 'https://api.payuni.com.tw/api/period/...',  // PayUNi permalink
  },
  {
    id: 'myapp:premium:monthly',
    product: 'myapp',
    tier: 'premium',
    display_name: 'Premium Monthly',
    billing_cycle: 'monthly',
    price: 599,
    quotas: { monthlyQuota: -1 },  // -1 = unlimited
    checkout_url: 'https://api.payuni.com.tw/api/period/...',
  },
];

for (const p of plans) {
  upsertPlan(p);
  console.log(`  seeded ${p.id}`);
}
process.exit(0);
```

Run: `node data/seed-myapp.js`

### Step 2: Backend — Check Subscription

In your product's server code:

```javascript
const gw = require('../../sdk/gateway');

// Helper: check subscription from PayGate
async function checkSubscription(email) {
  try {
    const result = await gw.call('paygate_check_subscription', {
      email,
      product: 'myapp',
    });
    return result?.data || result || { active: false };
  } catch {
    return { active: false };
  }
}

// Returns:
// { active: true, tier: 'basic', end_date: '2026-04-20T...', quotas: { monthlyQuota: 20 } }
// { active: false }
```

### Step 3: Backend — Email Linking Endpoint

Users verify their subscription by entering the email they used to pay:

```javascript
// In your API handler
const sub = await checkSubscription(email);

if (sub.active) {
  // Save subscription data locally (cache for fast quota checks)
  updateUser(userId, {
    email,
    subscriptionTier: sub.tier,
    subscriptionEnd: sub.end_date,
  });

  return { ok: true, subscription: { tier: sub.tier, endDate: sub.end_date } };
} else {
  return { ok: true, subscription: null };  // No active subscription
}
```

### Step 4: Backend — Fetch Plans for Frontend

```javascript
async function getPlans() {
  try {
    const result = await gw.call('paygate_list_plans', { product: 'myapp' });
    return result?.data?.plans || result?.plans || [];
  } catch {
    return [];
  }
}
// Returns: [{ id, tier, price, quotas, checkout_url, ... }]
```

### Step 5: Frontend — Paywall UI

```javascript
// 1. Fetch plans from backend (don't hardcode checkout URLs)
const plans = await fetch('/api/plans').then(r => r.json());

// 2. Render pricing cards with checkout_url links
plans.forEach(plan => {
  // <a href="${plan.checkout_url}" target="_blank">Subscribe ${plan.tier}</a>
});

// 3. After payment, user enters email to verify
const result = await fetch('/api/link-email', {
  method: 'POST',
  body: JSON.stringify({ email }),
});

if (result.subscription) {
  // Unlocked! Reload or update UI
} else {
  // "No active subscription found for this email"
}
```

### Step 6: Device Limit (Optional, Recommended)

Prevent account sharing — limit how many devices can use one subscription:

```javascript
// In your DB
function getDevicesByEmail(email) {
  return db.prepare('SELECT userId FROM users WHERE email = ?').all(email);
}

// In email-linking handler, before saving
const MAX_DEVICES = { basic: 2, premium: 3 };
const limit = MAX_DEVICES[sub.tier] || 2;
const others = getDevicesByEmail(email).filter(d => d.userId !== currentUserId);

if (others.length >= limit) {
  return { ok: false, error: 'device_limit',
    message: `This email is linked to ${others.length} devices (max ${limit})` };
}
```

### Complete Flow

```
User hits paywall → sees pricing (plans from PayGate)
  → clicks "Subscribe" → PayUNi checkout
  → pays → PayUNi webhook → PayGate creates subscription
  → user enters email → product calls check_subscription
  → PayGate returns { active: true, tier, quotas }
  → product caches locally → user unlocked
```

### Integration Checklist

- [ ] Seed plans: `node data/seed-myapp.js`
- [ ] Backend: `checkSubscription(email)` helper via Gateway SDK
- [ ] Backend: email-linking endpoint (verify + cache subscription data)
- [ ] Backend: plan-listing endpoint (proxy to PayGate)
- [ ] Frontend: pricing UI with dynamic checkout URLs
- [ ] Frontend: email verification flow
- [ ] Optional: device limit anti-sharing
- [ ] Optional: quota management (monthly reset, unlimited tier)
- [ ] Test: free → paid upgrade flow
- [ ] Test: expired subscription handling

---

## API Reference

### Purchases

#### `POST /api/webhook`

Called by payment provider. Auto-creates subscription if `product_id` matches a plan.

```bash
curl -X POST http://localhost:4019/api/webhook \
  -H "Authorization: Bearer $PAYGATE_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{ "email": "buyer@example.com", "product_id": "pokkit-pro",
        "order_id": "ORD-001", "plan": "lifetime", "amount": 990 }'
```

#### `POST /api/webhook/payuni`

PayUNi-specific webhook with AES-256-GCM encryption + CheckCode verification.

#### `GET /api/purchases/check?email=&product=`

**Public** (no auth). Check if user has paid.

```json
{ "active": true, "plan": "lifetime", "expires_at": null }
```

#### `GET /api/purchases/:email`

List all purchases (requires auth).

#### `POST /api/activate`

Manual activation (admin use).

### Subscriptions

#### `GET /api/subscription/check?email=&product=`

**Public** (no auth). Check active subscription with tier and quotas.

```json
{
  "active": true,
  "tier": "premium",
  "plan_id": "myapp:premium:monthly",
  "quotas": { "monthlyQuota": -1 },
  "end_date": "2026-04-20T01:51:45.000Z"
}
```

#### `POST /api/subscribe`

Manual subscription activation (admin use).

```bash
curl -X POST http://localhost:4019/api/subscribe \
  -H "Authorization: Bearer $PAYGATE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "email": "user@example.com", "product": "myapp", "plan_id": "myapp:basic:monthly" }'
```

#### `POST /api/subscriptions/expire-check`

Expire past-due subscriptions. Dispatches `subscription.expired` hooks. Run daily via cron.

### Plans

#### `GET /api/plans?product=`

**Public**. List plans for a product (with quotas and checkout URLs).

#### `POST /api/plans`

Create/update a plan (upsert by `id`). Requires auth.

### Hooks (Outgoing Webhooks)

#### `POST /api/hooks`

Register webhook URL. PayGate will POST HMAC-SHA256 signed events.

```bash
curl -X POST http://localhost:4019/api/hooks \
  -H "Authorization: Bearer $PAYGATE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "product": "myapp", "url": "https://myapp.com/webhooks/paygate",
        "secret": "your-hmac-secret",
        "events": ["subscription.activated", "subscription.expired"] }'
```

#### `GET /api/hooks`

List registered hooks (requires auth).

---

## Cross-Service Usage (Gateway SDK)

```javascript
const gw = require('../../sdk/gateway');

// Check subscription (most common)
const sub = await gw.call('paygate_check_subscription', { email, product: 'myapp' });
if (!sub.active) return res.status(402).json({ error: 'Please subscribe' });

// List plans (for pricing UI)
const { plans } = await gw.call('paygate_list_plans', { product: 'myapp' });

// Check one-time purchase
const purchase = await gw.call('paygate_check', { email, product: 'myapp' });
```

## Database

SQLite (`data/paygate.db`), WAL mode, `better-sqlite3`.

**Tables**: `purchases`, `plans`, `subscriptions`, `hooks`

```sql
-- Key tables (simplified)
CREATE TABLE plans (
  id TEXT PRIMARY KEY,        -- 'myapp:basic:monthly'
  product TEXT, tier TEXT, billing_cycle TEXT,
  price INTEGER, quotas TEXT, checkout_url TEXT,
  cb_product_id TEXT          -- CourseBloom product UUID (auto-match on webhook)
);

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,        -- 'sub_xxxx'
  email TEXT, product TEXT, plan_id TEXT, tier TEXT,
  status TEXT,                -- active | expired | cancelled
  start_date TEXT, end_date TEXT,
  UNIQUE(email, product)      -- one subscription per product per user
);
```

## Architecture

- **Runtime**: Node.js, CJS (`require` / `module.exports`)
- **HTTP**: Node built-in `http` module (no framework)
- **DB**: `better-sqlite3` (WAL mode)
- **Modules**: `server.js` (routes) + `db.js` + `plans.js` + `subscriptions.js` + `hooks.js`
- **Notifications**: Fire-and-forget via `sdk/gateway.js` (Mailer) + `sdk/telegram.js`

## License

MIT
