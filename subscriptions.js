const crypto = require('crypto');
const { getDb } = require('./db');
const { getPlanById, getPlanByCbProductId } = require('./plans');
const { dispatch } = require('./hooks');

function genSubId() {
  return 'sub_' + crypto.randomBytes(8).toString('hex');
}

function getCycleDays(cycle) {
  if (cycle === 'yearly') return 365;
  if (cycle === 'monthly') return 30;
  return null; // lifetime
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

function subscribe(email, product, planId) {
  const db = getDb();
  const plan = getPlanById(planId);
  if (!plan) throw new Error(`Plan not found: ${planId}`);
  if (plan.product !== product) throw new Error(`Plan ${planId} does not belong to product ${product}`);

  const cycleDays = getCycleDays(plan.billing_cycle);
  const now = new Date().toISOString();

  // Wrap in transaction to prevent race conditions
  const sub = db.transaction(() => {
    const existing = db.prepare(
      'SELECT s.*, p.price as current_price FROM subscriptions s LEFT JOIN plans p ON s.plan_id = p.id WHERE s.email = ? AND s.product = ?'
    ).get(email, product);

    if (!existing) {
      // New subscription
      const id = genSubId();
      const endDate = cycleDays ? addDays(now, cycleDays) : null;
      db.prepare(`
        INSERT INTO subscriptions (id, email, product, plan_id, tier, status, start_date, end_date)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
      `).run(id, email, product, planId, plan.tier, now, endDate);
      return db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);

    } else if (existing.status === 'active') {
      // Active: extend or upgrade (never downgrade)
      const baseDate = existing.end_date && new Date(existing.end_date) > new Date(now)
        ? existing.end_date : now;
      const newEnd = cycleDays ? addDays(baseDate, cycleDays) : null;

      if (plan.price >= (existing.current_price || 0)) {
        // Same tier or upgrade: switch plan + extend
        db.prepare(`
          UPDATE subscriptions SET plan_id = ?, tier = ?, end_date = ?, status = 'active'
          WHERE email = ? AND product = ?
        `).run(planId, plan.tier, newEnd, email, product);
      } else {
        // Downgrade attempt: extend at current tier
        db.prepare(`
          UPDATE subscriptions SET end_date = ?, status = 'active'
          WHERE email = ? AND product = ?
        `).run(newEnd, email, product);
      }
      return db.prepare('SELECT * FROM subscriptions WHERE email = ? AND product = ?').get(email, product);

    } else {
      // Expired or cancelled: reactivate
      const endDate = cycleDays ? addDays(now, cycleDays) : null;
      db.prepare(`
        UPDATE subscriptions SET plan_id = ?, tier = ?, status = 'active',
          start_date = ?, end_date = ?, auto_renew = 0
        WHERE email = ? AND product = ?
      `).run(planId, plan.tier, now, endDate, email, product);
      return db.prepare('SELECT * FROM subscriptions WHERE email = ? AND product = ?').get(email, product);
    }
  })();

  // Dispatch webhook (fire-and-forget, outside transaction)
  setImmediate(() => {
    dispatch(product, 'subscription.activated', { subscription: sub, plan }).catch(() => {});
  });

  return sub;
}

function checkSubscription(email, product) {
  const db = getDb();
  const sub = db.prepare(
    'SELECT s.*, p.quotas as plan_quotas FROM subscriptions s LEFT JOIN plans p ON s.plan_id = p.id WHERE s.email = ? AND s.product = ?'
  ).get(email, product);

  if (!sub || sub.status !== 'active') {
    return { active: false };
  }

  // Check expiry
  if (sub.end_date && new Date(sub.end_date) < new Date()) {
    return { active: false, expired: true };
  }

  return {
    active: true,
    tier: sub.tier,
    plan_id: sub.plan_id,
    quotas: JSON.parse(sub.plan_quotas || '{}'),
    end_date: sub.end_date,
  };
}

function cancelSubscription(id, reason) {
  const db = getDb();
  const sub = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
  if (!sub) throw new Error('Subscription not found');

  db.prepare("UPDATE subscriptions SET status = 'cancelled' WHERE id = ?").run(id);
  const updated = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
  const plan = getPlanById(sub.plan_id);

  setImmediate(() => {
    dispatch(sub.product, 'subscription.cancelled', {
      subscription: updated, plan, reason: reason || null,
    }).catch(() => {});
  });

  return updated;
}

function expireCheck() {
  const db = getDb();
  const now = new Date().toISOString();
  const overdue = db.prepare(
    "SELECT * FROM subscriptions WHERE status = 'active' AND end_date IS NOT NULL AND end_date < ?"
  ).all(now);

  // Batch update in transaction
  const expiredSubs = db.transaction(() => {
    const results = [];
    for (const sub of overdue) {
      db.prepare("UPDATE subscriptions SET status = 'expired' WHERE id = ?").run(sub.id);
      const updated = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(sub.id);
      results.push({ updated, plan: getPlanById(sub.plan_id), product: sub.product });
    }
    return results;
  })();

  // Dispatch webhooks outside transaction (fire-and-forget)
  for (const { updated, plan, product } of expiredSubs) {
    setImmediate(() => {
      dispatch(product, 'subscription.expired', { subscription: updated, plan }).catch(() => {});
    });
  }

  const total = db.prepare("SELECT COUNT(*) as c FROM subscriptions WHERE status = 'active'").get().c;
  return { expired: expiredSubs.length, checked: overdue.length + total };
}

/**
 * Called from webhook handler when a purchase matches a plan's cb_product_id.
 * Returns the subscription if created, or null if no matching plan.
 */
function handlePurchaseForSubscription(email, cbProductId) {
  const plan = getPlanByCbProductId(cbProductId);
  if (!plan) return null;
  return subscribe(email, plan.product, plan.id);
}

module.exports = {
  subscribe, checkSubscription, cancelSubscription, expireCheck,
  handlePurchaseForSubscription,
};
