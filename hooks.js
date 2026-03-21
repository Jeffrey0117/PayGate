const crypto = require('crypto');
const { getDb } = require('./db');

// Retry delays in seconds: 30s, 2m, 10m, 30m, 2h, 12h
const RETRY_DELAYS = [30, 120, 600, 1800, 7200, 43200];
const MAX_ATTEMPTS = RETRY_DELAYS.length;

function genHookId() {
  return 'hook_' + crypto.randomBytes(8).toString('hex');
}

function genDeliveryId() {
  return 'whd_' + crypto.randomBytes(8).toString('hex');
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

// ─── Persistent Webhook Delivery ───

async function attemptDelivery(deliveryId) {
  const db = getDb();
  const delivery = db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(deliveryId);
  if (!delivery || delivery.status === 'success' || delivery.status === 'dead') return;

  const now = new Date().toISOString();
  const newAttempts = delivery.attempts + 1;

  try {
    const response = await fetch(delivery.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': `sha256=${delivery.signature}`,
        'X-Webhook-Event': delivery.event,
        'X-Webhook-Delivery': deliveryId,
      },
      body: delivery.payload,
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      db.prepare(`
        UPDATE webhook_deliveries SET status = 'success', attempts = ?, last_attempt = ?, response_code = ?
        WHERE id = ?
      `).run(newAttempts, now, response.status, deliveryId);
      console.log(`[paygate] webhook ${delivery.url} -> ${response.status} (${deliveryId})`);
    } else {
      scheduleRetry(deliveryId, newAttempts, now, response.status, `HTTP ${response.status}`);
    }
  } catch (err) {
    scheduleRetry(deliveryId, newAttempts, now, null, err.message);
  }
}

function scheduleRetry(deliveryId, attempts, now, responseCode, errorMessage) {
  const db = getDb();

  if (attempts >= MAX_ATTEMPTS) {
    db.prepare(`
      UPDATE webhook_deliveries SET status = 'dead', attempts = ?, last_attempt = ?, response_code = ?, error_message = ?
      WHERE id = ?
    `).run(attempts, now, responseCode, errorMessage, deliveryId);
    console.error(`[paygate] webhook ${deliveryId} dead after ${attempts} attempts: ${errorMessage}`);
    return;
  }

  const delaySec = RETRY_DELAYS[attempts - 1] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
  const nextRetry = new Date(Date.now() + delaySec * 1000).toISOString();

  db.prepare(`
    UPDATE webhook_deliveries SET status = 'pending', attempts = ?, last_attempt = ?, next_retry = ?, response_code = ?, error_message = ?
    WHERE id = ?
  `).run(attempts, now, nextRetry, responseCode, errorMessage, deliveryId);
  console.log(`[paygate] webhook ${deliveryId} retry #${attempts} in ${delaySec}s`);
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
    const deliveryId = genDeliveryId();

    db.prepare(`
      INSERT INTO webhook_deliveries (id, hook_id, url, event, payload, signature, status, attempts, max_attempts)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?)
    `).run(deliveryId, hook.id, hook.url, event, bodyStr, signature, MAX_ATTEMPTS);

    await attemptDelivery(deliveryId);
  }
}

async function processRetryQueue() {
  const db = getDb();
  const now = new Date().toISOString();
  const pending = db.prepare(`
    SELECT id FROM webhook_deliveries
    WHERE status = 'pending' AND next_retry IS NOT NULL AND next_retry <= ?
    ORDER BY next_retry ASC LIMIT 20
  `).all(now);

  for (const row of pending) {
    await attemptDelivery(row.id);
  }

  if (pending.length > 0) {
    console.log(`[paygate] retry queue: processed ${pending.length} deliveries`);
  }
}

module.exports = { registerHook, listHooks, deleteHook, dispatch, processRetryQueue };
