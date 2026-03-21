const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Load .env (no dotenv dependency)
try {
  const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of envFile.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq > 0) {
      const k = t.slice(0, eq);
      if (!process.env[k]) process.env[k] = t.slice(eq + 1).replace(/^["']|["']$/g, '');
    }
  }
} catch {}

const { getDb } = require('./db');
const { listPlans, upsertPlan, deletePlan } = require('./plans');
const { subscribe, checkSubscription, cancelSubscription, expireCheck, handlePurchaseForSubscription } = require('./subscriptions');
const { registerHook, listHooks, deleteHook, processRetryQueue } = require('./hooks');

const PORT = parseInt(process.env.PORT || '4019', 10);

// ─── Helpers ───

const MAX_BODY_SIZE = 1024 * 1024; // 1MB

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_SIZE) { req.destroy(); return reject(new Error('Payload too large')); }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_SIZE) { req.destroy(); return reject(new Error('Payload too large')); }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function json(res, status, data) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(payload);
}

function requireAuth(req, envKey) {
  const expected = process.env[envKey];
  if (!expected) return false;
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

function generateId() {
  return 'pur_' + crypto.randomBytes(8).toString('hex');
}

function parsePathname(url) {
  try {
    return new URL(url, 'http://localhost').pathname;
  } catch {
    return url.split('?')[0];
  }
}

function parseQuery(url) {
  try {
    const u = new URL(url, 'http://localhost');
    return Object.fromEntries(u.searchParams.entries());
  } catch {
    return {};
  }
}

// ─── Rate Limiting ───

const rateLimits = new Map();
const RATE_LIMIT_PUBLIC = 100;
const RATE_LIMIT_AUTH = 300;
const RATE_LIMIT_WINDOW = 60000;

function checkRateLimit(ip, isAuthenticated) {
  const now = Date.now();
  const limit = isAuthenticated ? RATE_LIMIT_AUTH : RATE_LIMIT_PUBLIC;
  const entry = rateLimits.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimits.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return null;
  }

  entry.count += 1;
  if (entry.count > limit) {
    return Math.ceil((entry.resetAt - now) / 1000);
  }
  return null;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimits) {
    if (now > entry.resetAt) rateLimits.delete(ip);
  }
}, 300000);

// ─── Route Handlers ───

async function handleHealth(_req, res) {
  const db = getDb();
  const { total } = db.prepare('SELECT COUNT(*) as total FROM purchases').get();
  json(res, 200, { status: 'ok', service: 'paygate', totalPurchases: total });
}

async function handleWebhook(req, res) {
  if (!requireAuth(req, 'PAYGATE_WEBHOOK_SECRET')) {
    return json(res, 401, { error: 'Unauthorized' });
  }

  const body = await readBody(req);

  if (!body.email || !body.product_id) {
    return json(res, 400, { error: 'email and product_id are required' });
  }

  const db = getDb();

  // Idempotency check on order_id
  if (body.order_id) {
    const existing = db.prepare(
      'SELECT id, email, product_id, plan, status, amount, currency, paid_at, expires_at, source, order_id, created_at FROM purchases WHERE order_id = ?'
    ).get(body.order_id);

    if (existing) {
      return json(res, 200, { success: true, purchaseId: existing.id, duplicate: true });
    }
  }

  const purchaseId = generateId();
  const rawPayload = JSON.stringify(body);

  db.prepare(`
    INSERT INTO purchases (id, email, product_id, plan, status, amount, currency, expires_at, source, order_id, raw_payload)
    VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
  `).run(
    purchaseId,
    body.email,
    body.product_id,
    body.plan || '',
    body.amount || 0,
    body.currency || 'TWD',
    body.expires_at || null,
    body.source || '',
    body.order_id || null,
    rawPayload
  );

  // Async notifications (fire-and-forget, don't block response)
  setImmediate(async () => {
    try {
      const gw = require('../../sdk/gateway');
      await gw.call('mailer_send_template', {
        to: body.email,
        template: 'purchase_success',
        locale: 'zh',
        data: {
          name: body.email.split('@')[0],
          productName: body.product_id,
          amount: String(body.amount || 0),
          actionUrl: '',
        },
      });
    } catch (err) {
      console.error('[paygate] mailer notification failed:', err.message);
    }

    try {
      const tg = require('../../sdk/telegram');
      const msg = [
        'New purchase:',
        `${body.email} -> ${body.product_id}`,
        `(${body.amount || 0} ${body.currency || 'TWD'})`,
      ].join(' ');
      await tg.send(msg);
    } catch (err) {
      console.error('[paygate] telegram notification failed:', err.message);
    }
  });

  // Check if this purchase maps to a subscription plan
  let subscription = null;
  try {
    subscription = handlePurchaseForSubscription(body.email, body.product_id);
    if (subscription) {
      console.log(`[paygate] Subscription created/extended: ${subscription.email} -> ${subscription.tier}`);
    }
  } catch (err) {
    console.error('[paygate] Subscription processing error:', err.message);
  }

  return json(res, 200, {
    success: true,
    purchaseId,
    subscription: subscription ? { id: subscription.id, tier: subscription.tier } : undefined,
  });
}

async function handleCheck(req, res) {
  const query = parseQuery(req.url);
  const { email, product } = query;

  if (!email || !product) {
    return json(res, 400, { error: 'email and product query params are required' });
  }

  const db = getDb();
  const row = db.prepare(
    'SELECT plan, expires_at FROM purchases WHERE email = ? AND product_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1'
  ).get(email, product, 'active');

  if (!row) {
    return json(res, 200, { active: false });
  }

  // Check expiry
  if (row.expires_at) {
    const expiresAt = new Date(row.expires_at);
    if (expiresAt < new Date()) {
      return json(res, 200, { active: false, expired: true });
    }
  }

  return json(res, 200, {
    active: true,
    plan: row.plan,
    expires_at: row.expires_at || null,
  });
}

async function handleListPurchases(req, res, email) {
  if (!requireAuth(req, 'PAYGATE_TOKEN')) {
    return json(res, 401, { error: 'Unauthorized' });
  }

  const db = getDb();
  const purchases = db.prepare(
    'SELECT id, email, product_id, plan, status, amount, currency, paid_at, expires_at, source, order_id, created_at FROM purchases WHERE email = ? ORDER BY created_at DESC'
  ).all(email);

  return json(res, 200, { purchases });
}

async function handleActivate(req, res) {
  if (!requireAuth(req, 'PAYGATE_TOKEN')) {
    return json(res, 401, { error: 'Unauthorized' });
  }

  const body = await readBody(req);

  if (!body.email || !body.product_id) {
    return json(res, 400, { error: 'email and product_id are required' });
  }

  const db = getDb();
  const purchaseId = generateId();

  db.prepare(`
    INSERT INTO purchases (id, email, product_id, plan, status, amount, currency, expires_at, source)
    VALUES (?, ?, ?, ?, 'active', 0, 'TWD', ?, ?)
  `).run(
    purchaseId,
    body.email,
    body.product_id,
    body.plan || '',
    body.expires_at || null,
    body.source || 'manual'
  );

  // Also create subscription if a matching plan exists
  let subscription = null;
  try {
    subscription = handlePurchaseForSubscription(body.email, body.product_id);
  } catch (err) {
    console.error('[paygate] activate subscription error:', err.message);
  }

  return json(res, 200, { success: true, purchaseId, subscription: subscription ? { id: subscription.id, tier: subscription.tier } : undefined });
}

// ─── Plans Handlers ───

async function handleListPlans(req, res) {
  const query = parseQuery(req.url);
  const plans = listPlans(query.product);
  return json(res, 200, { plans });
}

async function handleCreatePlan(req, res) {
  if (!requireAuth(req, 'PAYGATE_TOKEN')) {
    return json(res, 401, { error: 'Unauthorized' });
  }
  const body = await readBody(req);
  const plan = upsertPlan(body);
  return json(res, 200, { success: true, plan });
}

async function handleDeletePlan(req, res, id) {
  if (!requireAuth(req, 'PAYGATE_TOKEN')) {
    return json(res, 401, { error: 'Unauthorized' });
  }
  deletePlan(id);
  return json(res, 200, { success: true });
}

// ─── Subscription Handlers ───

async function handleCheckSubscription(req, res) {
  const query = parseQuery(req.url);
  if (!query.email || !query.product) {
    return json(res, 400, { error: 'email and product query params are required' });
  }
  const result = checkSubscription(query.email, query.product);
  return json(res, 200, result);
}

async function handleSubscribe(req, res) {
  if (!requireAuth(req, 'PAYGATE_TOKEN')) {
    return json(res, 401, { error: 'Unauthorized' });
  }
  const body = await readBody(req);
  if (!body.email || !body.product || !body.plan_id) {
    return json(res, 400, { error: 'email, product, plan_id are required' });
  }
  const sub = subscribe(body.email, body.product, body.plan_id);
  return json(res, 200, { success: true, subscription: sub });
}

async function handleCancelSubscription(req, res, id) {
  if (!requireAuth(req, 'PAYGATE_TOKEN')) {
    return json(res, 401, { error: 'Unauthorized' });
  }
  const body = await readBody(req).catch(() => ({}));
  const sub = cancelSubscription(id, body.reason);
  return json(res, 200, { success: true, subscription: sub });
}

async function handleExpireCheck(req, res) {
  if (!requireAuth(req, 'PAYGATE_TOKEN')) {
    return json(res, 401, { error: 'Unauthorized' });
  }
  const result = expireCheck();
  return json(res, 200, result);
}

// ─── Hook Handlers ───

async function handleCreateHook(req, res) {
  if (!requireAuth(req, 'PAYGATE_TOKEN')) {
    return json(res, 401, { error: 'Unauthorized' });
  }
  const body = await readBody(req);
  const hook = registerHook(body);
  return json(res, 200, { success: true, hook });
}

async function handleListHooks(req, res) {
  if (!requireAuth(req, 'PAYGATE_TOKEN')) {
    return json(res, 401, { error: 'Unauthorized' });
  }
  const query = parseQuery(req.url);
  const hooks = listHooks(query.product);
  return json(res, 200, { hooks });
}

async function handleDeleteHook(req, res, id) {
  if (!requireAuth(req, 'PAYGATE_TOKEN')) {
    return json(res, 401, { error: 'Unauthorized' });
  }
  deleteHook(id);
  return json(res, 200, { success: true });
}

// ─── PAYUNi Webhook ───

function verifyPayUniCheckCode(params) {
  const hashKey = process.env.PAYUNI_HASH_KEY;
  const hashIV = process.env.PAYUNI_HASH_IV;
  if (!hashKey || !hashIV) return false;

  const { CheckCode, ...rest } = params;
  if (!CheckCode) return false;

  const sorted = Object.keys(rest).sort();
  const paramStr = sorted.map(k => `${k}=${rest[k]}`).join('&');
  const signStr = `HashKey=${hashKey}&${paramStr}&HashIV=${hashIV}`;
  const calculated = crypto.createHash('sha256').update(signStr).digest('hex').toUpperCase();
  return calculated === CheckCode;
}

function decryptPayUniEncryptInfo(encryptStr) {
  const hashKey = process.env.PAYUNI_HASH_KEY;
  const hashIV = process.env.PAYUNI_HASH_IV;
  if (!hashKey || !hashIV) return null;

  try {
    const raw = Buffer.from(encryptStr, 'hex');
    const sepIdx = raw.indexOf(':::');
    if (sepIdx === -1) return null;
    const encryptData = raw.slice(0, sepIdx);
    const tag = Buffer.from(raw.slice(sepIdx + 3).toString(), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', hashKey.trim(), hashIV.trim());
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encryptData, undefined, 'utf8');
    decrypted += decipher.final('utf8');
    const result = {};
    new URLSearchParams(decrypted).forEach((v, k) => { result[k] = v; });
    return result;
  } catch (err) {
    console.error('[paygate] PAYUNi decrypt failed:', err.message);
    return null;
  }
}

function verifyPayUniHashInfo(encryptStr) {
  const hashKey = process.env.PAYUNI_HASH_KEY;
  const hashIV = process.env.PAYUNI_HASH_IV;
  if (!hashKey || !hashIV) return null;
  return crypto.createHash('sha256').update(hashKey + encryptStr + hashIV).digest('hex').toUpperCase();
}

async function handlePayUniWebhook(req, res) {
  const raw = await readRawBody(req);
  console.log('[paygate] PAYUNi webhook raw:', raw);

  // Parse form-urlencoded or JSON
  let params;
  const ct = req.headers['content-type'] || '';
  if (ct.includes('application/json')) {
    try { params = JSON.parse(raw); } catch { return json(res, 400, { error: 'Invalid JSON' }); }
  } else {
    params = {};
    new URLSearchParams(raw).forEach((v, k) => { params[k] = v; });
  }

  console.log('[paygate] PAYUNi webhook params:', JSON.stringify(params));

  // Two modes: EncryptInfo (AES-256-GCM) or plain params with CheckCode
  let data = params;

  if (params.EncryptInfo) {
    // Verify HashInfo
    if (params.HashInfo) {
      const expected = verifyPayUniHashInfo(params.EncryptInfo);
      if (expected !== params.HashInfo) {
        console.error('[paygate] PAYUNi HashInfo mismatch');
        return json(res, 401, { error: 'Invalid HashInfo' });
      }
    }
    // Decrypt
    const decrypted = decryptPayUniEncryptInfo(params.EncryptInfo);
    if (!decrypted) {
      return json(res, 400, { error: 'Decrypt failed' });
    }
    console.log('[paygate] PAYUNi decrypted:', JSON.stringify(decrypted));
    data = decrypted;
  } else if (params.CheckCode) {
    // Verify CheckCode signature
    if (!verifyPayUniCheckCode(params)) {
      console.error('[paygate] PAYUNi CheckCode mismatch');
      return json(res, 401, { error: 'Invalid CheckCode' });
    }
  } else {
    console.error('[paygate] PAYUNi webhook: no EncryptInfo or CheckCode');
    return json(res, 400, { error: 'Missing EncryptInfo or CheckCode' });
  }

  // Extract fields (try common PAYUNi field names)
  const status = data.Status || data.TradeStatus;
  const tradeNo = data.TradeNo || '';
  const orderNo = data.MerchantOrderNo || data.MerTradeNo || '';
  const amount = parseInt(data.TradeAmt || data.PeriodAmt || '0', 10);
  const email = data.PayerEmail || data.Email || data.email || '';

  console.log(`[paygate] PAYUNi parsed: status=${status}, tradeNo=${tradeNo}, amount=${amount}, email=${email}`);

  // Only process successful payments
  const isSuccess = status === 'SUCCESS' || status === '1';
  if (!isSuccess) {
    console.log('[paygate] PAYUNi: payment not successful, status:', status);
    return json(res, 200, { success: true, message: 'Status noted', status });
  }

  // Match amount to plan (search ALL products)
  const allPlans = listPlans(); // no product filter
  const candidates = allPlans.filter(p => p.price === amount);
  let matchedPlan = candidates[0] || null;
  if (candidates.length > 1) {
    console.warn(`[paygate] PAYUNi: ${candidates.length} plans match amount ${amount}: ${candidates.map(p => p.id).join(', ')}. Using first match.`);
  }

  const productId = matchedPlan ? matchedPlan.product : 'unknown';

  if (!matchedPlan) {
    console.log(`[paygate] PAYUNi: no plan matches amount ${amount}`);
    const db = getDb();
    const purchaseId = generateId();
    db.prepare(`
      INSERT INTO purchases (id, email, product_id, plan, status, amount, currency, source, order_id, raw_payload)
      VALUES (?, ?, ?, '', 'active', ?, 'TWD', 'payuni', ?, ?)
    `).run(purchaseId, email || 'unknown', productId, amount, tradeNo, JSON.stringify(data));
    return json(res, 200, { success: true, purchaseId, message: 'No matching plan' });
  }

  if (!email) {
    console.error('[paygate] PAYUNi: no email in webhook data. Fields:', Object.keys(data).join(', '));
    const db = getDb();
    const purchaseId = generateId();
    db.prepare(`
      INSERT INTO purchases (id, email, product_id, plan, status, amount, currency, source, order_id, raw_payload)
      VALUES (?, 'unknown', ?, ?, 'active', ?, 'TWD', 'payuni', ?, ?)
    `).run(purchaseId, productId, matchedPlan.id, amount, tradeNo, JSON.stringify(data));

    setImmediate(async () => {
      try {
        const tg = require('../../sdk/telegram');
        await tg.send(`PAYUNi payment ${amount} TWD (${productId}/${matchedPlan.tier}) but NO EMAIL. TradeNo: ${tradeNo}. Check raw_payload.`);
      } catch {}
    });

    return json(res, 200, { success: true, purchaseId, message: 'No email, saved for manual matching' });
  }

  // Idempotency check
  const db = getDb();
  if (tradeNo) {
    const existing = db.prepare('SELECT id FROM purchases WHERE order_id = ?').get(tradeNo);
    if (existing) {
      return json(res, 200, { success: true, purchaseId: existing.id, duplicate: true });
    }
  }

  // Record purchase
  const purchaseId = generateId();
  db.prepare(`
    INSERT INTO purchases (id, email, product_id, plan, status, amount, currency, source, order_id, raw_payload)
    VALUES (?, ?, ?, ?, 'active', ?, 'TWD', 'payuni', ?, ?)
  `).run(purchaseId, email, productId, matchedPlan.id, amount, tradeNo, JSON.stringify(data));

  // Create subscription
  let subscription = null;
  try {
    subscription = subscribe(email, productId, matchedPlan.id);
    console.log(`[paygate] PAYUNi subscription created: ${email} -> ${productId}/${matchedPlan.tier}`);
  } catch (err) {
    console.error('[paygate] PAYUNi subscription error:', err.message);
  }

  // Async notifications
  setImmediate(async () => {
    try {
      const tg = require('../../sdk/telegram');
      await tg.send(`PAYUNi subscription: ${email} -> ${productId}/${matchedPlan.tier} ($${amount})`);
    } catch {}
    try {
      const gw = require('../../sdk/gateway');
      await gw.call('mailer_send_template', {
        to: email,
        template: 'purchase_success',
        locale: 'zh',
        data: {
          name: email.split('@')[0],
          productName: `${productId} ${matchedPlan.display_name || matchedPlan.tier}`,
          amount: String(amount),
          actionUrl: '',
        },
      });
    } catch {}
  });

  return json(res, 200, { success: true, purchaseId, subscription: subscription ? { id: subscription.id, tier: subscription.tier } : undefined });
}

// ─── Admin Handlers ───

async function handleAdminStats(req, res) {
  if (!requireAuth(req, 'PAYGATE_TOKEN')) {
    return json(res, 401, { error: 'Unauthorized' });
  }

  const db = getDb();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();

  const totalPurchases = db.prepare('SELECT COUNT(*) as c FROM purchases').get().c;
  const activeSubscriptions = db.prepare("SELECT COUNT(*) as c FROM subscriptions WHERE status = 'active'").get().c;

  const activeByProduct = db.prepare(`
    SELECT product, tier, COUNT(*) as count
    FROM subscriptions WHERE status = 'active'
    GROUP BY product, tier ORDER BY product, count DESC
  `).all();

  const revenueByProduct = db.prepare(`
    SELECT product_id as product, SUM(amount) as revenue, COUNT(*) as transactions, currency
    FROM purchases WHERE paid_at >= ? AND status = 'active'
    GROUP BY product_id, currency ORDER BY revenue DESC
  `).all(thirtyDaysAgo);

  const planDistribution = db.prepare(`
    SELECT s.plan_id, p.product, p.tier, p.display_name, p.price, COUNT(*) as subscribers
    FROM subscriptions s LEFT JOIN plans p ON s.plan_id = p.id
    WHERE s.status = 'active'
    GROUP BY s.plan_id ORDER BY subscribers DESC
  `).all();

  const recentPurchases = db.prepare(`
    SELECT id, email, product_id, plan, amount, currency, source, paid_at, created_at
    FROM purchases ORDER BY created_at DESC LIMIT 10
  `).all();

  let webhookStats = [];
  try {
    webhookStats = db.prepare('SELECT status, COUNT(*) as count FROM webhook_deliveries GROUP BY status').all();
  } catch {}

  return json(res, 200, {
    overview: { totalPurchases, activeSubscriptions },
    activeByProduct,
    revenueByProduct,
    planDistribution,
    recentPurchases,
    webhookStats,
  });
}

async function handleWebhookLog(req, res) {
  if (!requireAuth(req, 'PAYGATE_TOKEN')) {
    return json(res, 401, { error: 'Unauthorized' });
  }

  const query = parseQuery(req.url);
  const limit = Math.min(parseInt(query.limit || '50', 10), 200);
  const status = query.status;

  const db = getDb();
  let deliveries;
  if (status) {
    deliveries = db.prepare(
      'SELECT * FROM webhook_deliveries WHERE status = ? ORDER BY created_at DESC LIMIT ?'
    ).all(status, limit);
  } else {
    deliveries = db.prepare(
      'SELECT * FROM webhook_deliveries ORDER BY created_at DESC LIMIT ?'
    ).all(limit);
  }

  return json(res, 200, { deliveries });
}

// ─── Router ───

function matchRoute(method, pathname) {
  if (method === 'GET' && pathname === '/api/health') {
    return { handler: handleHealth };
  }
  if (method === 'POST' && pathname === '/api/webhook') {
    return { handler: handleWebhook };
  }
  if (method === 'POST' && pathname === '/api/webhook/payuni') {
    return { handler: handlePayUniWebhook };
  }
  if (method === 'GET' && pathname === '/api/purchases/check') {
    return { handler: handleCheck };
  }
  if (method === 'POST' && pathname === '/api/activate') {
    return { handler: handleActivate };
  }

  // /api/purchases/:email
  const purchasesMatch = pathname.match(/^\/api\/purchases\/([^/]+)$/);
  if (method === 'GET' && purchasesMatch) {
    const email = decodeURIComponent(purchasesMatch[1]);
    // Avoid matching the "check" sub-route
    if (email === 'check') return null;
    return { handler: handleListPurchases, params: [email] };
  }

  // Plans
  if (method === 'GET' && pathname === '/api/plans') {
    return { handler: handleListPlans };
  }
  if (method === 'POST' && pathname === '/api/plans') {
    return { handler: handleCreatePlan };
  }
  const planDeleteMatch = pathname.match(/^\/api\/plans\/(.+)$/);
  if (method === 'DELETE' && planDeleteMatch) {
    return { handler: handleDeletePlan, params: [decodeURIComponent(planDeleteMatch[1])] };
  }

  // Subscriptions
  if (method === 'GET' && pathname === '/api/subscription/check') {
    return { handler: handleCheckSubscription };
  }
  if (method === 'POST' && pathname === '/api/subscribe') {
    return { handler: handleSubscribe };
  }
  if (method === 'POST' && pathname === '/api/subscriptions/expire-check') {
    return { handler: handleExpireCheck };
  }
  const subDeleteMatch = pathname.match(/^\/api\/subscription\/([^/]+)$/);
  if (method === 'DELETE' && subDeleteMatch && subDeleteMatch[1] !== 'check') {
    return { handler: handleCancelSubscription, params: [subDeleteMatch[1]] };
  }

  // Hooks
  if (method === 'POST' && pathname === '/api/hooks') {
    return { handler: handleCreateHook };
  }
  if (method === 'GET' && pathname === '/api/hooks') {
    return { handler: handleListHooks };
  }
  const hookDeleteMatch = pathname.match(/^\/api\/hooks\/([^/]+)$/);
  if (method === 'DELETE' && hookDeleteMatch) {
    return { handler: handleDeleteHook, params: [hookDeleteMatch[1]] };
  }

  // Admin
  if (method === 'GET' && pathname === '/api/admin/stats') {
    return { handler: handleAdminStats };
  }
  if (method === 'GET' && pathname === '/api/admin/webhook-log') {
    return { handler: handleWebhookLog };
  }

  return null;
}

// ─── Server ───

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  // Rate limiting
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
  const isAuth = (req.headers['authorization'] || '').startsWith('Bearer ');
  const retryAfter = checkRateLimit(ip, isAuth);
  if (retryAfter !== null) {
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': String(retryAfter),
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(JSON.stringify({ error: 'Too many requests', retryAfter }));
  }

  const pathname = parsePathname(req.url);
  const route = matchRoute(req.method, pathname);

  if (!route) {
    return json(res, 404, { error: 'Not found' });
  }

  try {
    const params = route.params || [];
    await route.handler(req, res, ...params);
  } catch (err) {
    console.error(`[paygate] ${req.method} ${pathname} error:`, err.message);
    json(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`[paygate] Payment gateway running on port ${PORT}`);
});

// Webhook retry queue — process every 30 seconds
const retryTimer = setInterval(() => {
  processRetryQueue().catch(err => {
    console.error('[paygate] retry queue error:', err.message);
  });
}, 30000);

// Graceful shutdown
process.on('SIGTERM', () => {
  clearInterval(retryTimer);
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  clearInterval(retryTimer);
  server.close(() => process.exit(0));
});
