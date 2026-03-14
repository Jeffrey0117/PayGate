const http = require('http');
const crypto = require('crypto');
const { getDb } = require('./db');
const { listPlans, upsertPlan, deletePlan } = require('./plans');
const { subscribe, checkSubscription, cancelSubscription, expireCheck, handlePurchaseForSubscription } = require('./subscriptions');
const { registerHook, listHooks, deleteHook } = require('./hooks');

const PORT = parseInt(process.env.PORT || '4019', 10);

// ─── Helpers ───

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new Error('Invalid JSON')); }
    });
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
  return token === expected;
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

  return json(res, 200, { success: true, purchaseId });
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

// ─── Router ───

function matchRoute(method, pathname) {
  if (method === 'GET' && pathname === '/api/health') {
    return { handler: handleHealth };
  }
  if (method === 'POST' && pathname === '/api/webhook') {
    return { handler: handleWebhook };
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
