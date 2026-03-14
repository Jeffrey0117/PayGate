const crypto = require('crypto');
const { getDb } = require('./db');

function genHookId() {
  return 'hook_' + crypto.randomBytes(8).toString('hex');
}

function registerHook(data) {
  const db = getDb();
  const { product, url, secret, events } = data;
  if (!product || !url || !secret) {
    throw new Error('product, url, secret are required');
  }
  const id = genHookId();
  const eventsStr = typeof events === 'string' ? events : JSON.stringify(events || ['subscription.activated']);
  db.prepare(`
    INSERT INTO hooks (id, product, url, secret, events)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(product, url) DO UPDATE SET
      secret = excluded.secret,
      events = excluded.events,
      enabled = 1
  `).run(id, product, url, secret, eventsStr);
  return db.prepare('SELECT * FROM hooks WHERE product = ? AND url = ?').get(product, url);
}

function listHooks(product) {
  const db = getDb();
  if (product) {
    return db.prepare('SELECT id, product, url, events, enabled, created_at FROM hooks WHERE product = ?').all(product);
  }
  return db.prepare('SELECT id, product, url, events, enabled, created_at FROM hooks').all();
}

function deleteHook(id) {
  const db = getDb();
  db.prepare('DELETE FROM hooks WHERE id = ?').run(id);
}

function hmacSign(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function dispatch(product, event, data) {
  const db = getDb();
  const hooks = db.prepare(
    'SELECT * FROM hooks WHERE product = ? AND enabled = 1'
  ).all(product);

  for (const hook of hooks) {
    const events = JSON.parse(hook.events || '[]');
    if (!events.includes(event)) continue;

    const payload = { event, timestamp: new Date().toISOString(), data };
    const bodyStr = JSON.stringify(payload);
    const signature = hmacSign(hook.secret, bodyStr);

    try {
      const response = await fetch(hook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': `sha256=${signature}`,
          'X-Webhook-Event': event,
        },
        body: bodyStr,
        signal: AbortSignal.timeout(10000),
      });
      console.log(`[paygate] hook ${hook.url} -> ${response.status}`);
    } catch (err) {
      console.error(`[paygate] hook ${hook.url} failed:`, err.message);
    }
  }
}

module.exports = { registerHook, listHooks, deleteHook, dispatch };
