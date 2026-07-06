/**
 * Tests for the pure prefix-first matching logic (no DB / no server).
 * Run: node --test test-prefix-matching.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const {
  extractPrefix,
  normalizePrefix,
  checkPrefixConflict,
  matchPayment,
} = require('./matching');

// Two products sharing a price of 599 — the collision the feature fixes.
const PLANS = [
  { id: 'lurlhub:member:monthly', product: 'lurlhub', price: 599, tier: 'basic', prefix: 'LS' },
  { id: 'lurlhub:premium:monthly', product: 'lurlhub', price: 899, tier: 'premium', prefix: 'LS' },
  { id: 'keybox:premium:monthly', product: 'keybox', price: 599, tier: 'premium', prefix: 'KB' },
  { id: 'upimg:premium:monthly', product: 'upimg', price: 299, tier: 'premium', prefix: null }, // legacy, no prefix
  { id: 'reelscript:pro:monthly', product: 'reelscript', price: 299, tier: 'pro', prefix: null },
];

test('extractPrefix pulls leading letters, uppercased', () => {
  assert.strictEqual(extractPrefix('LS17299abc'), 'LS');
  assert.strictEqual(extractPrefix('kb0099'), 'KB');
  assert.strictEqual(extractPrefix('12345'), '');
  assert.strictEqual(extractPrefix(''), '');
  assert.strictEqual(extractPrefix(null), '');
});

test('normalizePrefix validates 2-4 uppercase alphanumeric', () => {
  assert.strictEqual(normalizePrefix('ls'), 'LS');
  assert.strictEqual(normalizePrefix('PD'), 'PD');
  assert.strictEqual(normalizePrefix('LR12'), 'LR12');
  assert.strictEqual(normalizePrefix(''), null);
  assert.strictEqual(normalizePrefix(undefined), null);
  assert.throws(() => normalizePrefix('X'), /2-4 uppercase/);      // too short
  assert.throws(() => normalizePrefix('TOOLONG'), /2-4 uppercase/); // too long
  assert.throws(() => normalizePrefix('L-S'), /2-4 uppercase/);     // bad char
});

test('prefix uniqueness: same prefix, different product → conflict (409 owner)', () => {
  const map = { LS: 'lurlhub', KB: 'keybox' };
  assert.strictEqual(checkPrefixConflict('LS', 'keybox', map), 'lurlhub'); // conflict, returns owner
  assert.strictEqual(checkPrefixConflict('LS', 'lurlhub', map), null);     // same product, OK
  assert.strictEqual(checkPrefixConflict('PD', 'coursebloom', map), null); // free, OK
});

test('prefix-first match: LS order at 599 activates lurlhub, NOT keybox', () => {
  const r = matchPayment({ merTradeNo: 'LS17299X8F2', amount: 599, plans: PLANS });
  assert.strictEqual(r.path, 'prefix');
  assert.strictEqual(r.prefix, 'LS');
  assert.strictEqual(r.product, 'lurlhub');
  assert.strictEqual(r.matchedPlan.id, 'lurlhub:member:monthly');
});

test('prefix-first match: KB order at 599 activates keybox (same price, different product)', () => {
  const r = matchPayment({ merTradeNo: 'KB0099AA', amount: 599, plans: PLANS });
  assert.strictEqual(r.path, 'prefix');
  assert.strictEqual(r.product, 'keybox');
  assert.strictEqual(r.matchedPlan.id, 'keybox:premium:monthly');
});

test('prefix matched but amount matches no plan in that product → stays in product, no cross-product activation', () => {
  const r = matchPayment({ merTradeNo: 'LS17299X8F2', amount: 12345, plans: PLANS });
  assert.strictEqual(r.path, 'prefix');
  assert.strictEqual(r.product, 'lurlhub'); // pinned to lurlhub, not leaked elsewhere
  assert.strictEqual(r.matchedPlan, null);  // no activation
});

test('legacy fallback: unregistered prefix → global amount match (unchanged behavior)', () => {
  const r = matchPayment({ merTradeNo: 'ZZ0001', amount: 299, plans: PLANS });
  assert.strictEqual(r.path, 'amount-fallback');
  assert.ok(r.matchedPlan);
  assert.strictEqual(r.matchedPlan.price, 299);
});

test('legacy fallback: no MerTradeNo → global amount match', () => {
  const r = matchPayment({ merTradeNo: '', amount: 899, plans: PLANS });
  assert.strictEqual(r.path, 'amount-fallback');
  assert.strictEqual(r.matchedPlan.id, 'lurlhub:premium:monthly');
});

test('longest registered prefix wins when prefixes overlap', () => {
  const plans = [
    { id: 'a', product: 'prodA', price: 100, prefix: 'LS' },
    { id: 'b', product: 'prodB', price: 100, prefix: 'LST' },
  ];
  const r = matchPayment({ merTradeNo: 'LST123', amount: 100, plans });
  assert.strictEqual(r.prefix, 'LST');
  assert.strictEqual(r.product, 'prodB');
});
