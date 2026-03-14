// data/seed-upimg.js — Run once to seed upimg membership plans
const { getDb } = require('../db');
const { upsertPlan } = require('../plans');
const { registerHook } = require('../hooks');

const plans = [
  {
    id: 'upimg:guest:monthly',
    product: 'upimg', tier: 'guest', display_name: 'Free',
    billing_cycle: 'monthly', price: 0,
    quotas: { maxUploadPerDay: 10, maxUploadPerMonth: 100, maxStorage: 104857600, maxImageCount: 100, maxAlbums: 3, maxItemsPerAlbum: 20 },
    checkout_url: null, cb_product_id: null,
  },
  {
    id: 'upimg:member:monthly',
    product: 'upimg', tier: 'member', display_name: 'Member Monthly',
    billing_cycle: 'monthly', price: 99,
    quotas: { maxUploadPerDay: 50, maxUploadPerMonth: 500, maxStorage: 1073741824, maxImageCount: 1000, maxAlbums: 10, maxItemsPerAlbum: 100 },
    checkout_url: 'https://classroo.tw/htmlcat2025/checkout/product/8f69a372-3359-49ae-8843-814c7bd726ba',
    cb_product_id: '8f69a372-3359-49ae-8843-814c7bd726ba',
  },
  {
    id: 'upimg:member:yearly',
    product: 'upimg', tier: 'member', display_name: 'Member Yearly',
    billing_cycle: 'yearly', price: 990,
    quotas: { maxUploadPerDay: 50, maxUploadPerMonth: 500, maxStorage: 1073741824, maxImageCount: 1000, maxAlbums: 10, maxItemsPerAlbum: 100 },
    checkout_url: 'https://classroo.tw/htmlcat2025/checkout/product/270c681e-bde7-457c-bbb0-6405442fff84',
    cb_product_id: '270c681e-bde7-457c-bbb0-6405442fff84',
  },
  {
    id: 'upimg:premium:monthly',
    product: 'upimg', tier: 'premium', display_name: 'Premium Monthly',
    billing_cycle: 'monthly', price: 299,
    quotas: { maxUploadPerDay: 200, maxUploadPerMonth: 3000, maxStorage: 5368709120, maxImageCount: 5000, maxAlbums: 50, maxItemsPerAlbum: 500 },
    checkout_url: 'https://classroo.tw/htmlcat2025/checkout/product/4c6a0992-09e7-4567-af64-223ff7c28587',
    cb_product_id: '4c6a0992-09e7-4567-af64-223ff7c28587',
  },
  {
    id: 'upimg:premium:yearly',
    product: 'upimg', tier: 'premium', display_name: 'Premium Yearly',
    billing_cycle: 'yearly', price: 2990,
    quotas: { maxUploadPerDay: 200, maxUploadPerMonth: 3000, maxStorage: 5368709120, maxImageCount: 5000, maxAlbums: 50, maxItemsPerAlbum: 500 },
    checkout_url: 'https://classroo.tw/htmlcat2025/checkout/product/a5a0168b-01e9-4fa8-9557-8d4cc6b40a71',
    cb_product_id: 'a5a0168b-01e9-4fa8-9557-8d4cc6b40a71',
  },
];

// Init DB
getDb();

console.log('Seeding upimg plans...');
for (const p of plans) {
  upsertPlan(p);
  console.log(`  + ${p.id} (${p.display_name})`);
}

// Register upimg webhook hook
const hook = registerHook({
  product: 'upimg',
  url: 'https://duk.tw/api/webhooks/paygate',
  secret: 'dc5499750a1666b816cbe4f6a451379f7efc6c3d04eac2b0983e1a0e07cf51c9',
  events: ['subscription.activated', 'subscription.expired', 'subscription.cancelled'],
});
console.log(`  + Hook registered: ${hook.url}`);

console.log('Done!');
process.exit(0);
