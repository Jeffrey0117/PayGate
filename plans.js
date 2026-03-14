const { getDb } = require('./db');

function listPlans(product) {
  const db = getDb();
  const query = product
    ? 'SELECT * FROM plans WHERE product = ? AND is_active = 1 ORDER BY price ASC'
    : 'SELECT * FROM plans WHERE is_active = 1 ORDER BY product, price ASC';
  const rows = product ? db.prepare(query).all(product) : db.prepare(query).all();
  return rows.map(r => ({ ...r, quotas: JSON.parse(r.quotas || '{}') }));
}

function getPlanById(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
  if (!row) return null;
  return { ...row, quotas: JSON.parse(row.quotas || '{}') };
}

function getPlanByCbProductId(cbProductId) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM plans WHERE cb_product_id = ? AND is_active = 1').get(cbProductId);
  if (!row) return null;
  return { ...row, quotas: JSON.parse(row.quotas || '{}') };
}

function upsertPlan(data) {
  const db = getDb();
  const { id, product, tier, display_name, billing_cycle, price, currency, quotas, checkout_url, cb_product_id } = data;
  if (!id || !product || !tier || !billing_cycle) {
    throw new Error('id, product, tier, billing_cycle are required');
  }
  db.prepare(`
    INSERT INTO plans (id, product, tier, display_name, billing_cycle, price, currency, quotas, checkout_url, cb_product_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      product = excluded.product,
      tier = excluded.tier,
      display_name = excluded.display_name,
      billing_cycle = excluded.billing_cycle,
      price = excluded.price,
      currency = excluded.currency,
      quotas = excluded.quotas,
      checkout_url = excluded.checkout_url,
      cb_product_id = excluded.cb_product_id
  `).run(
    id, product, tier,
    display_name || '',
    billing_cycle,
    price || 0,
    currency || 'TWD',
    typeof quotas === 'string' ? quotas : JSON.stringify(quotas || {}),
    checkout_url || null,
    cb_product_id || null
  );
  return getPlanById(id);
}

function deletePlan(id) {
  const db = getDb();
  db.prepare('UPDATE plans SET is_active = 0 WHERE id = ?').run(id);
}

module.exports = { listPlans, getPlanById, getPlanByCbProductId, upsertPlan, deletePlan };
