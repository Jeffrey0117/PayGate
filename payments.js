/**
 * One-time payment sessions (單筆付款).
 *
 * A product calls createPaymentSession() to get a hosted checkout URL for a
 * dynamic amount tied to its own order_id. PAYUNi notifies /api/webhook/payuni;
 * the session is completed there (or via simulatePayment in dev), a purchase
 * row is recorded, and a `purchase.completed` webhook is dispatched to the
 * product. refundPayment() reverses a paid session via PAYUNi trade/close and
 * dispatches `purchase.refunded`.
 */
const crypto = require('crypto');
const { getDb } = require('./db');
const { dispatch } = require('./hooks');

const PAYUNI_BASE = () =>
  process.env.PAYUNI_TEST_MODE === 'true'
    ? 'https://sandbox-api.payuni.com.tw/api'
    : 'https://api.payuni.com.tw/api';

const publicUrl = () =>
  (process.env.PAYGATE_PUBLIC_URL || `http://localhost:${process.env.PORT || 4019}`).replace(/\/$/, '');

function genPaymentId() {
  return 'pay_' + crypto.randomBytes(8).toString('hex');
}

function genPurchaseId() {
  return 'pur_' + crypto.randomBytes(8).toString('hex');
}

// PAYUNi MerTradeNo: unique, alphanumeric, <= 20 chars.
function genMerTradeNo() {
  return 'PG' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 8);
}

// ─── PAYUNi crypto (AES-256-GCM, official format) ───
// EncryptInfo = hex( base64(ciphertext) + ":::" + base64(authTag) )
// HashInfo    = SHA256( HashKey + EncryptInfo + HashIV ).toUpperCase()

function encryptPayUniInfo(plaintext) {
  const hashKey = process.env.PAYUNI_HASH_KEY;
  const hashIV = process.env.PAYUNI_HASH_IV;
  if (!hashKey || !hashIV) throw new Error('PAYUNI_HASH_KEY / PAYUNI_HASH_IV not configured');
  const cipher = crypto.createCipheriv('aes-256-gcm', hashKey.trim(), hashIV.trim());
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.from(ct.toString('base64') + ':::' + tag.toString('base64')).toString('hex');
}

function decryptPayUniInfo(encryptStr) {
  const hashKey = process.env.PAYUNI_HASH_KEY;
  const hashIV = process.env.PAYUNI_HASH_IV;
  if (!hashKey || !hashIV) return null;
  try {
    const raw = Buffer.from(encryptStr, 'hex').toString('utf8');
    const sepIdx = raw.indexOf(':::');
    if (sepIdx === -1) return null;
    const ct = Buffer.from(raw.slice(0, sepIdx), 'base64');
    const tag = Buffer.from(raw.slice(sepIdx + 3), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', hashKey.trim(), hashIV.trim());
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    const result = {};
    new URLSearchParams(pt).forEach((v, k) => { result[k] = v; });
    return result;
  } catch {
    return null;
  }
}

function hashPayUniInfo(encryptStr) {
  const hashKey = process.env.PAYUNI_HASH_KEY;
  const hashIV = process.env.PAYUNI_HASH_IV;
  return crypto.createHash('sha256').update(hashKey + encryptStr + hashIV).digest('hex').toUpperCase();
}

function toQueryString(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

// ─── Sessions ───

function getSession(id) {
  return getDb().prepare('SELECT * FROM payment_sessions WHERE id = ?').get(id);
}

function getSessionByMerTradeNo(merTradeNo) {
  return getDb().prepare('SELECT * FROM payment_sessions WHERE mer_trade_no = ?').get(merTradeNo);
}

function touchSession(id, patch) {
  const db = getDb();
  const keys = Object.keys(patch);
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE payment_sessions SET ${sets}, updated_at = datetime('now') WHERE id = ?`)
    .run(...keys.map((k) => patch[k]), id);
  return getSession(id);
}

/**
 * Create (or idempotently return) a payment session.
 * Input: { product, order_id, amount, email?, item_desc?, return_url? }
 */
function createPaymentSession(input) {
  const { product, order_id, amount } = input;
  if (!product || !order_id) throw new Error('product and order_id are required');
  const amt = Math.round(Number(amount));
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('amount must be a positive integer');

  const db = getDb();
  const existing = db.prepare(
    'SELECT * FROM payment_sessions WHERE product = ? AND order_id = ?'
  ).get(product, order_id);
  if (existing) {
    if (existing.status === 'refunded' || existing.status === 'failed') {
      throw new Error(`payment session already ${existing.status} for this order`);
    }
    return { session: existing, duplicate: true };
  }

  const id = genPaymentId();
  const merTradeNo = genMerTradeNo();
  db.prepare(`
    INSERT INTO payment_sessions (id, product, order_id, email, amount, item_desc, return_url, status, mer_trade_no)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    id,
    product,
    order_id,
    (input.email || '').trim(),
    amt,
    (input.item_desc || `${product} order`).slice(0, 60),
    input.return_url || '',
    merTradeNo
  );

  return { session: getSession(id), duplicate: false };
}

function checkoutUrlFor(session) {
  return `${publicUrl()}/pay/${session.id}`;
}

/** Build the auto-submit PAYUNi UPP form for a pending session. */
function buildCheckoutForm(session) {
  const merId = process.env.PAYUNI_MERCHANT_ID;
  if (!merId) throw new Error('PAYUNI_MERCHANT_ID not configured');

  const params = {
    MerID: merId,
    MerTradeNo: session.mer_trade_no,
    TradeAmt: session.amount,
    Timestamp: Math.floor(Date.now() / 1000),
    ProdDesc: session.item_desc || 'Order',
    ReturnURL: `${publicUrl()}/pay/return`,
    NotifyURL: `${publicUrl()}/api/webhook/payuni`,
    ...(session.email ? { UsrMail: session.email } : {}),
  };

  const encryptInfo = encryptPayUniInfo(toQueryString(params));
  const hashInfo = hashPayUniInfo(encryptInfo);
  const action = `${PAYUNI_BASE()}/upp`;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>前往付款…</title></head>
<body>
  <form id="payuni" method="POST" action="${esc(action)}">
    <input type="hidden" name="MerID" value="${esc(merId)}" />
    <input type="hidden" name="Version" value="1.0" />
    <input type="hidden" name="EncryptInfo" value="${esc(encryptInfo)}" />
    <input type="hidden" name="HashInfo" value="${esc(hashInfo)}" />
    <noscript><button type="submit">前往付款</button></noscript>
  </form>
  <script>document.getElementById('payuni').submit();</script>
</body>
</html>`;
}

/**
 * Mark a session paid, record the purchase, dispatch purchase.completed.
 * Idempotent — returns the existing purchase on repeat calls.
 */
function completePaymentSession(sessionId, { tradeNo = '', source = 'payuni', rawPayload = null } = {}) {
  const db = getDb();
  const session = getSession(sessionId);
  if (!session) throw new Error(`payment session not found: ${sessionId}`);
  if (session.status === 'paid') {
    return { session, purchaseId: session.purchase_id, duplicate: true };
  }
  if (session.status !== 'pending') {
    throw new Error(`cannot complete session in status ${session.status}`);
  }

  const purchaseId = genPurchaseId();
  db.prepare(`
    INSERT INTO purchases (id, email, product_id, plan, status, amount, currency, source, order_id, raw_payload)
    VALUES (?, ?, ?, '', 'active', ?, ?, ?, ?, ?)
  `).run(
    purchaseId,
    session.email || 'unknown',
    session.product,
    session.amount,
    session.currency || 'TWD',
    source,
    session.order_id,
    rawPayload ? JSON.stringify(rawPayload) : null
  );

  const updated = touchSession(sessionId, { status: 'paid', trade_no: tradeNo, purchase_id: purchaseId });

  setImmediate(() => {
    dispatch(session.product, 'purchase.completed', {
      purchase: {
        id: purchaseId,
        payment_id: session.id,
        product: session.product,
        order_id: session.order_id,
        email: session.email,
        amount: session.amount,
        currency: session.currency || 'TWD',
        trade_no: tradeNo,
        paid_at: new Date().toISOString(),
      },
    }).catch((err) => console.error('[paygate] purchase.completed dispatch error:', err.message));
  });

  return { session: updated, purchaseId, duplicate: false };
}

/**
 * Refund a paid session via PAYUNi trade/close (CloseType 2 = 退款).
 * Marks the purchase refunded and dispatches purchase.refunded.
 */
async function refundPayment(sessionId) {
  const db = getDb();
  const session = getSession(sessionId);
  if (!session) throw new Error(`payment session not found: ${sessionId}`);
  if (session.status === 'refunded') {
    return { session, duplicate: true };
  }
  if (session.status !== 'paid') {
    throw new Error(`cannot refund session in status ${session.status}`);
  }

  // Simulated sessions (dev) have no PAYUNi trade — skip the PSP call.
  if (session.trade_no && session.trade_no !== 'SIMULATED') {
    const merId = process.env.PAYUNI_MERCHANT_ID;
    if (!merId) throw new Error('PAYUNI_MERCHANT_ID not configured');
    const params = {
      MerID: merId,
      TradeNo: session.trade_no,
      CloseType: 2,
      Timestamp: Math.floor(Date.now() / 1000),
    };
    const encryptInfo = encryptPayUniInfo(toQueryString(params));
    const hashInfo = hashPayUniInfo(encryptInfo);

    const resp = await fetch(`${PAYUNI_BASE()}/trade/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ MerID: merId, Version: '1.0', EncryptInfo: encryptInfo, HashInfo: hashInfo }).toString(),
      signal: AbortSignal.timeout(15000),
    });
    const text = await resp.text();
    let result = {};
    try { result = JSON.parse(text); } catch { /* PAYUNi may return urlencoded */ }
    if (result.EncryptInfo) {
      const decrypted = decryptPayUniInfo(result.EncryptInfo);
      if (decrypted) result = { ...result, ...decrypted };
    }
    const status = result.Status || '';
    if (status !== 'SUCCESS') {
      throw new Error(`PAYUNi refund failed: ${result.Message || status || text.slice(0, 200)}`);
    }
  }

  if (session.purchase_id) {
    db.prepare("UPDATE purchases SET status = 'refunded' WHERE id = ?").run(session.purchase_id);
  }
  const updated = touchSession(sessionId, { status: 'refunded' });

  setImmediate(() => {
    dispatch(session.product, 'purchase.refunded', {
      purchase: {
        id: session.purchase_id,
        payment_id: session.id,
        product: session.product,
        order_id: session.order_id,
        email: session.email,
        amount: session.amount,
        currency: session.currency || 'TWD',
        refunded_at: new Date().toISOString(),
      },
    }).catch((err) => console.error('[paygate] purchase.refunded dispatch error:', err.message));
  });

  return { session: updated, duplicate: false };
}

/** Dev helper: mark a pending session paid without a PSP round-trip. */
function simulatePayment(sessionId) {
  if (process.env.PAYGATE_ALLOW_SIMULATE !== '1') {
    throw new Error('simulate is disabled (set PAYGATE_ALLOW_SIMULATE=1)');
  }
  return completePaymentSession(sessionId, { tradeNo: 'SIMULATED', source: 'simulated' });
}

module.exports = {
  createPaymentSession,
  getSession,
  getSessionByMerTradeNo,
  checkoutUrlFor,
  buildCheckoutForm,
  completePaymentSession,
  refundPayment,
  simulatePayment,
  decryptPayUniInfo,
};
