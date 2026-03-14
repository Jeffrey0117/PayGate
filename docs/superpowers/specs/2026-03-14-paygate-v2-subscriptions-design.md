# PayGate v2: Subscription & Membership System

**Date**: 2026-03-14
**Status**: Approved
**Scope**: Upgrade PayGate from purchase-only to purchase + subscription + outgoing webhook

## Context

PayGate currently stores one-time purchases and exposes a public check endpoint. Products like upimg built their own membership system (4 Prisma tables, 500 lines) because PayGate lacked subscription management. This design centralizes subscription logic into PayGate so any CloudPipe product can add membership in minutes.

### Existing Ecosystem

| Service | Port | Role |
|---------|------|------|
| PayGate | 4019 | Purchase database + webhook receiver |
| Mailer | 4018 | Email sending (purchase_success template) |
| LaunchKit | 4020 | JSON to landing page (has pricing section) |

### What upimg built (to be replaced)

- `MembershipPlan` table (tier definitions)
- `UserMembership` table (active subscriptions)
- `Invoice` table (payment records)
- `membership-service.ts` (~200 lines of activation/expiry/plans logic)
- `PricingTable.tsx` (fetches plans, renders pricing cards)
- Webhook receiver for CourseBloom
- Cron safety net for missed webhooks

## Decision Record

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Architecture | Extend PayGate (not new service) | Single port, single DB, consistent with ecosystem |
| State management | Centralized in PayGate | Products only manage local quota enforcement |
| Quota format | JSON (flexible) | Each product has different limits |
| Payment source | CourseBloom only (for now) | Ship core first, extend later |
| Data migration | Migrate upimg data to PayGate | Single source of truth |
| Identity | Email-based | Cross-system, no product-specific userId dependency |
| Dates | All UTC | SQLite `datetime('now')` is UTC. Cron schedules use Asia/Taipei timezone. |

## Data Model

### New Tables (existing `purchases` table unchanged)

```sql
CREATE TABLE IF NOT EXISTS plans (
  id            TEXT PRIMARY KEY,    -- 'upimg:member:monthly'
  product       TEXT NOT NULL,       -- 'upimg'
  tier          TEXT NOT NULL,       -- 'member'
  display_name  TEXT DEFAULT '',     -- 'Member Monthly'
  billing_cycle TEXT NOT NULL,       -- 'monthly' | 'yearly' | 'lifetime'
  price         INTEGER DEFAULT 0,  -- cents (TWD)
  currency      TEXT DEFAULT 'TWD',
  quotas        TEXT DEFAULT '{}',   -- JSON, product interprets
  checkout_url  TEXT,                -- full CourseBloom checkout URL
  cb_product_id TEXT,                -- CourseBloom product UUID (for webhook matching)
  is_active     INTEGER DEFAULT 1,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id            TEXT PRIMARY KEY,    -- sub_xxxxxxxxxxxxxxxx
  email         TEXT NOT NULL,
  product       TEXT NOT NULL,       -- 'upimg'
  plan_id       TEXT NOT NULL,       -- -> plans.id
  tier          TEXT NOT NULL,       -- denormalized for fast queries
  status        TEXT DEFAULT 'active', -- active | expired | cancelled
  start_date    TEXT DEFAULT (datetime('now')),
  end_date      TEXT,                -- NULL = never expires (lifetime)
  auto_renew    INTEGER DEFAULT 0,
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(email, product)            -- one subscription per user per product
);

-- Auto-update updated_at on any UPDATE
CREATE TRIGGER IF NOT EXISTS trg_subscriptions_updated_at
AFTER UPDATE ON subscriptions
BEGIN
  UPDATE subscriptions SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TABLE IF NOT EXISTS hooks (
  id            TEXT PRIMARY KEY,    -- hook_xxxxxxxxxxxxxxxx
  product       TEXT NOT NULL,
  url           TEXT NOT NULL,
  secret        TEXT NOT NULL,       -- HMAC-SHA256 signing key
  events        TEXT DEFAULT '["subscription.activated"]', -- JSON array
  enabled       INTEGER DEFAULT 1,
  created_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(product, url)
);

CREATE INDEX IF NOT EXISTS idx_plans_product ON plans(product);
CREATE INDEX IF NOT EXISTS idx_plans_cb_product ON plans(cb_product_id);
CREATE INDEX IF NOT EXISTS idx_subs_email_product ON subscriptions(email, product);
CREATE INDEX IF NOT EXISTS idx_subs_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subs_end_date ON subscriptions(end_date);
CREATE INDEX IF NOT EXISTS idx_hooks_product ON hooks(product);
```

### ID Generation

Consistent with existing PayGate pattern (`pur_` + 16 hex chars):

```javascript
const crypto = require('crypto');
const genId = (prefix) => prefix + '_' + crypto.randomBytes(8).toString('hex');
// sub_a1b2c3d4e5f6g7h8
// hook_a1b2c3d4e5f6g7h8
// plans.id is human-readable: '{product}:{tier}:{cycle}'
```

### Key Constraints

- `subscriptions.UNIQUE(email, product)`: One subscription per user per product. Renewals extend `end_date`. Status transitions (expired/cancelled/active) always UPDATE the same row, never INSERT a second one.
- `plans.id` format: `{product}:{tier}:{cycle}` for human readability.
- `quotas` is opaque JSON. PayGate stores it, products interpret it.
- `updated_at` auto-updated via SQLite trigger on every UPDATE.

### Subscription State Transitions

```
(none) --subscribe--> active
active --cron expire--> expired
active --user cancel--> cancelled (end_date preserved, features until expiry)
expired --re-subscribe--> active (new start_date, new end_date)
cancelled --re-subscribe--> active (new start_date, new end_date, cancellation cleared)
```

When a cancelled subscription still has a future `end_date` (user cancelled auto-renew but time remains), re-subscribing resets to active with a new cycle starting from now.

### Downgrade Policy

Downgrades are **not supported**. If a premium user purchases a member plan, it is treated as a renewal at the **higher** tier (premium). Products only ever go up, never down. The subscribe logic:

```
IF existing.tier_level >= new_plan.tier_level:
  Extend end_date at existing tier (ignore the lower plan)
ELSE:
  Upgrade: switch to new plan, extend end_date
```

Tier levels are defined per product in the plans table. PayGate compares by price (higher price = higher tier) as a universal heuristic.

## API Endpoints

### CORS

All endpoints support `GET, POST, DELETE, OPTIONS` methods.

```javascript
'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'
```

### Plans (admin token required except GET)

```
GET  /api/plans?product=upimg
  Response: { plans: [{ id, product, tier, display_name, billing_cycle, price, currency, quotas, checkout_url, is_active }] }
  Note: Public, no auth. quotas returned as parsed JSON object.

POST /api/plans  (Auth: Bearer PAYGATE_TOKEN)
  Body: { id, product, tier, display_name, billing_cycle, price, currency, quotas, checkout_url, cb_product_id }
  Response: { success: true, plan: {...} }
  Note: Upserts by id

DELETE /api/plans/:id  (Auth: Bearer PAYGATE_TOKEN)
  Response: { success: true }
```

### Subscriptions

```
GET  /api/subscription/check?email=user@example.com&product=upimg
  Response (active): { active: true, tier: 'premium', plan_id: 'upimg:premium:monthly', quotas: {...}, end_date: '2027-03-13T00:00:00Z' }
  Response (none):   { active: false }
  Note: Public, no auth. Returns quotas from joined plan. Internal network only (CloudPipe proxy).

POST /api/subscribe  (Auth: Bearer PAYGATE_TOKEN)
  Body: { email, product, plan_id }
  Response: { success: true, subscription: {...} }
  Note: Creates or extends subscription. Upgrade = switch plan + extend. Same/lower tier = extend at current tier.

DELETE /api/subscription/:id  (Auth: Bearer PAYGATE_TOKEN)
  Body: { reason?: string }
  Response: { success: true }
  Note: Sets status to 'cancelled'. Does NOT delete row. Does NOT change end_date (features continue until expiry).

POST /api/subscriptions/expire-check  (Auth: Bearer PAYGATE_TOKEN)
  Response: { expired: 3, checked: 150 }
  Note: Finds active subscriptions past end_date, sets status to 'expired', dispatches hooks.
```

### Hooks (outgoing webhook management)

```
POST /api/hooks  (Auth: Bearer PAYGATE_TOKEN)
  Body: { product, url, secret, events? }
  Response: { success: true, hook: {...} }

GET  /api/hooks?product=upimg  (Auth: Bearer PAYGATE_TOKEN)
  Response: { hooks: [...] }

DELETE /api/hooks/:id  (Auth: Bearer PAYGATE_TOKEN)
  Response: { success: true }
```

## Core Flow: Purchase to Subscription

```
1. User pays on CourseBloom
2. CourseBloom webhook → PayGate POST /api/webhook (existing)
3. PayGate stores purchase in `purchases` table (existing logic)
   - If duplicate (order_id exists): return early, do NOT process subscription
4. NEW: If new purchase, PayGate checks plans table for matching cb_product_id
   - Found? → Create/extend subscription via internal subscribe()
   - Not found? → One-time purchase only (existing behavior)
5. NEW: If subscription created → dispatch outgoing webhooks to registered hooks
   - Event: 'subscription.activated'
   - Payload: { event, timestamp, subscription, plan }
   - Signed: HMAC-SHA256 with hook secret
6. Existing: Send confirmation email via Mailer
7. Existing: Telegram notification
```

**Idempotency**: Subscription creation ONLY happens for new purchases. When `duplicate: true` (existing order_id), the webhook handler returns early before step 4. This prevents the same payment from extending a subscription twice.

### Subscription Extension Logic

```
subscribe(email, product, plan_id):
  existing = SELECT FROM subscriptions WHERE email AND product
  plan = SELECT FROM plans WHERE id = plan_id

  IF no existing:
    INSERT new subscription (start_date = now, end_date = now + cycle)

  ELSE IF existing.status == 'active':
    IF plan.price >= existing_plan.price (same tier or upgrade):
      new_end = MAX(existing.end_date, now) + cycle_duration
      UPDATE end_date = new_end, plan_id = plan.id, tier = plan.tier
    ELSE (downgrade attempt):
      // Treat as renewal at current higher tier
      new_end = MAX(existing.end_date, now) + cycle_duration
      UPDATE end_date = new_end (keep existing plan_id and tier)

  ELSE (expired or cancelled):
    UPDATE status = 'active', start_date = now, end_date = now + cycle,
           plan_id = plan.id, tier = plan.tier, auto_renew = 0

  cycle_duration:
    monthly = 30 days
    yearly = 365 days
    lifetime = end_date = NULL (never expires)
```

## Outgoing Webhook Dispatch

```
dispatch(product, event, data):
  hooks = SELECT FROM hooks WHERE product AND enabled AND events CONTAINS event
  FOR each hook:
    body = JSON.stringify({ event, timestamp: new Date().toISOString(), data })
    signature = HMAC-SHA256(hook.secret, body)
    POST hook.url
      Headers: Content-Type: application/json
               X-Webhook-Signature: sha256={signature}
               X-Webhook-Event: {event}
      Body: body
      Timeout: 10 seconds
    Log success/failure to console (fire-and-forget, errors don't block)
```

### Webhook Reliability

Outgoing webhooks are fire-and-forget (no retry queue). If a product's webhook receiver is down, the subscription exists in PayGate but the product won't know.

**Safety net**: Products should use `GET /api/subscription/check` as a reconciliation mechanism. Options:
- (a) On user login, call PayGate check and sync local quota if mismatched
- (b) Periodic cron (e.g., weekly) to reconcile active subscriptions with PayGate
- (c) Both (recommended)

This replaces upimg's old dedicated cron with a lighter, generic approach.

### Events

All events use a consistent payload shape:

| Event | Trigger | Payload |
|-------|---------|---------|
| `subscription.activated` | New subscription or renewal | `{ subscription, plan }` |
| `subscription.expired` | Cron expire-check | `{ subscription, plan }` |
| `subscription.cancelled` | Manual cancellation | `{ subscription, plan, reason? }` |

## Product Integration (upimg example)

### Before (current, ~500 lines)

```
upimg manages: MembershipPlan, UserMembership, Invoice tables
upimg has: membership-service.ts (activation, expiry, plans, invoices)
upimg has: webhook receiver for CourseBloom
upimg has: cron safety net
upimg has: PricingTable fetches /api/membership/plans
```

### After (~50 lines)

```
upimg keeps: UserQuota table (local enforcement only)
upimg has: webhook receiver for PayGate (~30 lines)
upimg has: PricingTable fetches PayGate /api/plans?product=upimg

Webhook receiver (POST /api/webhooks/paygate):
  1. Verify HMAC signature (X-Webhook-Signature header)
  2. Parse event type
  3. If subscription.activated:
     - Extract tier + quotas from payload
     - Find user by email (case-insensitive)
     - Upsert UserQuota with new limits
     - Update user.tier
  4. If subscription.expired:
     - Find user by email
     - Reset UserQuota to free tier limits
     - Update user.tier = 'guest'
  5. Return { received: true }

On user login (reconciliation safety net):
  fetch PayGate /api/subscription/check?email=&product=upimg
  If active and local tier doesn't match → sync UserQuota
```

### Migration Steps

1. Seed PayGate `plans` table with upimg's 4 membership plans + quotas
2. Migrate `UserMembership` rows → PayGate `subscriptions`:
   ```sql
   -- Join through User table to get email
   SELECT u.email, um.status, um.startDate, um.endDate, um.autoRenew,
          mp.name as tier, mp.billingCycle
   FROM UserMembership um
   JOIN User u ON um.userId = u.id
   JOIN MembershipPlan mp ON um.planId = mp.id
   WHERE u.email IS NOT NULL AND u.email != ''
   ```
   Users without email are skipped (they can re-activate via login + PayGate check).
3. Register outgoing hook: PayGate → duk.tw/api/webhooks/paygate
4. Update upimg PricingTable to fetch from PayGate
5. Replace upimg webhook receiver (CourseBloom → PayGate)
6. Add login-time reconciliation (call PayGate check, sync UserQuota)
7. Remove upimg's MembershipPlan, UserMembership, Invoice tables (after verification)
8. Remove upimg's membership-service.ts (most of it)
9. Remove upimg's CourseBloom cron job

## File Structure

```
workhub/paygate/
├── server.js           # HTTP routing (~300 lines, add new routes + CORS update)
├── db.js               # SQLite init (add 3 tables + indexes + trigger)
├── subscriptions.js    # NEW: subscribe, check, extend, expire (~150 lines)
├── plans.js            # NEW: CRUD for plans (~60 lines)
├── hooks.js            # NEW: outgoing webhook dispatch + HMAC signing (~80 lines)
├── README.md           # Update with new endpoints
└── data/paygate.db     # Existing SQLite
```

## CloudPipe Integration

### Manifest additions (paygate.json)

```json
[
  { "name": "list_plans", "method": "GET", "path": "/api/plans" },
  { "name": "create_plan", "method": "POST", "path": "/api/plans" },
  { "name": "check_subscription", "method": "GET", "path": "/api/subscription/check" },
  { "name": "subscribe", "method": "POST", "path": "/api/subscribe" },
  { "name": "register_hook", "method": "POST", "path": "/api/hooks" },
  { "name": "expire_check", "method": "POST", "path": "/api/subscriptions/expire-check" }
]
```

### New schedule

```json
{
  "id": "paygate-expire-check",
  "cron": "0 4 * * *",
  "timezone": "Asia/Taipei",
  "description": "Check and expire overdue subscriptions (runs 4:00 AM Taipei / 20:00 UTC)",
  "type": "tool",
  "tool": "paygate_expire_check"
}
```

### Remove schedule

- `upimg-check-purchases.json` (no longer needed, replaced by login-time reconciliation + PayGate expire-check)

## Testing

1. **Unit**: Create plan → subscribe → check → verify active
2. **Expiry**: Create subscription with past end_date → run expire-check → verify expired + hook dispatched
3. **Webhook flow**: Simulate CourseBloom webhook → verify purchase + subscription created + hook dispatched
4. **Idempotency**: Same webhook twice (same order_id) → subscription extended once (not duplicated)
5. **Upgrade**: member active → purchase premium → verify tier upgraded + end_date extended
6. **Downgrade blocked**: premium active → purchase member → verify stays premium + end_date extended
7. **Re-subscribe**: expired subscription → new purchase → verify reactivated
8. **Migration**: Seed from upimg data → verify all subscriptions queryable via check endpoint
9. **upimg E2E**: PayGate hook → upimg webhook → UserQuota updated → user sees new tier
