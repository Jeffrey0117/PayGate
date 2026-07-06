const { getDb } = require('./db');
const { normalizePrefix, checkPrefixConflict } = require('./matching');

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

/** { PREFIX: product } for all active plans that carry a prefix. */
function listPrefixes() {
  const db = getDb();
  const rows = db.prepare(
    "SELECT DISTINCT prefix, product FROM plans WHERE prefix IS NOT NULL AND prefix != '' AND is_active = 1"
  ).all();
  const map = {};
  for (const r of rows) map[r.prefix] = r.product;
  return map;
}

function upsertPlan(data) {
  const db = getDb();
  const { id, product, tier, display_name, billing_cycle, price, currency, quotas, checkout_url, cb_product_id } = data;
  if (!id || !product || !tier || !billing_cycle) {
    throw new Error('id, product, tier, billing_cycle are required');
  }

  // Optional order prefix: validate + enforce one-prefix-per-product.
  const prefix = normalizePrefix(data.prefix); // throws (status 400) on bad format, null if absent
  if (prefix) {
    const owner = checkPrefixConflict(prefix, product, listPrefixes());
    if (owner) {
      const e = new Error(`Prefix "${prefix}" is already registered to product "${owner}". Choose a different prefix.`);
      e.status = 409;
      throw e;
    }
  }

  // COALESCE preserves an existing prefix when a caller upserts without one
  // (e.g. re-running a seed that predates prefixes) instead of clobbering it.
  db.prepare(`
    INSERT INTO plans (id, product, tier, display_name, billing_cycle, price, currency, quotas, checkout_url, cb_product_id, prefix)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      product = excluded.product,
      tier = excluded.tier,
      display_name = excluded.display_name,
      billing_cycle = excluded.billing_cycle,
      price = excluded.price,
      currency = excluded.currency,
      quotas = excluded.quotas,
      checkout_url = excluded.checkout_url,
      cb_product_id = excluded.cb_product_id,
      prefix = COALESCE(excluded.prefix, plans.prefix)
  `).run(
    id, product, tier,
    display_name || '',
    billing_cycle,
    price || 0,
    currency || 'TWD',
    typeof quotas === 'string' ? quotas : JSON.stringify(quotas || {}),
    checkout_url || null,
    cb_product_id || null,
    prefix
  );
  return getPlanById(id);
}

function deletePlan(id) {
  const db = getDb();
  db.prepare('UPDATE plans SET is_active = 0 WHERE id = ?').run(id);
}

module.exports = { listPlans, listPrefixes, getPlanById, getPlanByCbProductId, upsertPlan, deletePlan };
