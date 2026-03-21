const Database = require('better-sqlite3');
const { mkdirSync } = require('fs');
const { join } = require('path');

let db;

function getDb() {
  if (db) return db;

  const dbPath = join(__dirname, 'data', 'paygate.db');
  mkdirSync(join(__dirname, 'data'), { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS purchases (
      id          TEXT PRIMARY KEY,
      email       TEXT NOT NULL,
      product_id  TEXT NOT NULL,
      plan        TEXT DEFAULT '',
      status      TEXT DEFAULT 'active',
      amount      INTEGER DEFAULT 0,
      currency    TEXT DEFAULT 'TWD',
      paid_at     TEXT DEFAULT (datetime('now')),
      expires_at  TEXT,
      source      TEXT DEFAULT '',
      order_id    TEXT,
      raw_payload TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_purchases_email ON purchases(email);
    CREATE INDEX IF NOT EXISTS idx_purchases_product ON purchases(product_id);
    CREATE INDEX IF NOT EXISTS idx_purchases_order ON purchases(order_id);

    CREATE TABLE IF NOT EXISTS plans (
      id            TEXT PRIMARY KEY,
      product       TEXT NOT NULL,
      tier          TEXT NOT NULL,
      display_name  TEXT DEFAULT '',
      billing_cycle TEXT NOT NULL,
      price         INTEGER DEFAULT 0,
      currency      TEXT DEFAULT 'TWD',
      quotas        TEXT DEFAULT '{}',
      checkout_url  TEXT,
      cb_product_id TEXT,
      is_active     INTEGER DEFAULT 1,
      created_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_plans_product ON plans(product);
    CREATE INDEX IF NOT EXISTS idx_plans_cb_product ON plans(cb_product_id);

    CREATE TABLE IF NOT EXISTS subscriptions (
      id            TEXT PRIMARY KEY,
      email         TEXT NOT NULL,
      product       TEXT NOT NULL,
      plan_id       TEXT NOT NULL,
      tier          TEXT NOT NULL,
      status        TEXT DEFAULT 'active',
      start_date    TEXT DEFAULT (datetime('now')),
      end_date      TEXT,
      auto_renew    INTEGER DEFAULT 0,
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now')),
      UNIQUE(email, product)
    );
    CREATE INDEX IF NOT EXISTS idx_subs_email_product ON subscriptions(email, product);
    CREATE INDEX IF NOT EXISTS idx_subs_status ON subscriptions(status);
    CREATE INDEX IF NOT EXISTS idx_subs_end_date ON subscriptions(end_date);

    CREATE TRIGGER IF NOT EXISTS trg_subscriptions_updated_at
    AFTER UPDATE ON subscriptions
    BEGIN
      UPDATE subscriptions SET updated_at = datetime('now') WHERE id = NEW.id;
    END;

    CREATE TABLE IF NOT EXISTS hooks (
      id            TEXT PRIMARY KEY,
      product       TEXT NOT NULL,
      url           TEXT NOT NULL,
      secret        TEXT NOT NULL,
      events        TEXT DEFAULT '["subscription.activated"]',
      enabled       INTEGER DEFAULT 1,
      created_at    TEXT DEFAULT (datetime('now')),
      UNIQUE(product, url)
    );
    CREATE INDEX IF NOT EXISTS idx_hooks_product ON hooks(product);

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id            TEXT PRIMARY KEY,
      hook_id       TEXT NOT NULL,
      url           TEXT NOT NULL,
      event         TEXT NOT NULL,
      payload       TEXT NOT NULL,
      signature     TEXT NOT NULL,
      status        TEXT DEFAULT 'pending',
      attempts      INTEGER DEFAULT 0,
      max_attempts  INTEGER DEFAULT 6,
      last_attempt  TEXT,
      next_retry    TEXT,
      response_code INTEGER,
      error_message TEXT,
      created_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_wd_status ON webhook_deliveries(status);
    CREATE INDEX IF NOT EXISTS idx_wd_next_retry ON webhook_deliveries(next_retry);
    CREATE INDEX IF NOT EXISTS idx_wd_hook_id ON webhook_deliveries(hook_id);
  `);

  return db;
}

module.exports = { getDb };
