/**
 * Pure payment→plan matching logic (no DB, no I/O — unit-testable).
 *
 * A PAYUNi order's MerTradeNo carries a product prefix (e.g. "LS17299…",
 * "KB…"). Matching by amount alone collides when two products share a price,
 * so we match prefix-first: if the order's leading letters map to a registered
 * prefix, we restrict amount-matching to THAT product's plans. Orders whose
 * prefix isn't registered (legacy / unregistered products) fall back to the
 * original global amount match, unchanged.
 */

const PREFIX_RE = /^[A-Z0-9]{2,4}$/;

/** Leading alphabetic characters of a MerTradeNo, uppercased ('' if none). */
function extractPrefix(merTradeNo) {
  if (!merTradeNo) return '';
  const m = String(merTradeNo).match(/^[A-Za-z]+/);
  return m ? m[0].toUpperCase() : '';
}

/** Normalize a candidate prefix to uppercase, or throw if malformed. Empty → null. */
function normalizePrefix(prefix) {
  if (prefix === undefined || prefix === null || prefix === '') return null;
  const up = String(prefix).trim().toUpperCase();
  if (!PREFIX_RE.test(up)) {
    const e = new Error(`Invalid prefix "${prefix}": must be 2-4 uppercase alphanumeric characters`);
    e.status = 400;
    throw e;
  }
  return up;
}

/** Build { PREFIX: product } from a list of plan rows (first writer wins per prefix). */
function buildPrefixMap(plans) {
  const map = {};
  for (const p of plans || []) {
    if (p && p.prefix) {
      const pref = String(p.prefix).toUpperCase();
      if (!map[pref]) map[pref] = p.product;
    }
  }
  return map;
}

/**
 * Uniqueness decision (pure): returns the owning product if `prefix` is already
 * registered to a DIFFERENT product, else null (free, or owned by same product).
 */
function checkPrefixConflict(prefix, product, prefixMap) {
  const owner = (prefixMap || {})[String(prefix).toUpperCase()];
  return owner && owner !== product ? owner : null;
}

/**
 * Match a payment to a plan.
 * @param {{ merTradeNo?: string, amount: number, plans: Array }} args
 * @returns {{ path: 'prefix'|'amount-fallback', prefix: string|null, product: string|null, matchedPlan: object|null, candidates: Array }}
 */
function matchPayment({ merTradeNo, amount, plans }) {
  const all = Array.isArray(plans) ? plans : [];
  const prefixMap = buildPrefixMap(all);
  const mtn = String(merTradeNo || '').toUpperCase();

  // Longest registered prefix the order starts with wins (most specific).
  let matchedPrefix = '';
  for (const pref of Object.keys(prefixMap)) {
    if (mtn.startsWith(pref) && pref.length > matchedPrefix.length) {
      matchedPrefix = pref;
    }
  }

  if (matchedPrefix) {
    const product = prefixMap[matchedPrefix];
    const productPlans = all.filter((p) => p.product === product);
    const candidates = productPlans.filter((p) => p.price === amount);
    return {
      path: 'prefix',
      prefix: matchedPrefix,
      product,
      matchedPlan: candidates[0] || null,
      candidates,
    };
  }

  // No registered prefix → original global amount match (semantics unchanged).
  const candidates = all.filter((p) => p.price === amount);
  return {
    path: 'amount-fallback',
    prefix: extractPrefix(merTradeNo) || null,
    product: candidates[0] ? candidates[0].product : null,
    matchedPlan: candidates[0] || null,
    candidates,
  };
}

module.exports = {
  extractPrefix,
  normalizePrefix,
  buildPrefixMap,
  checkPrefixConflict,
  matchPayment,
};
