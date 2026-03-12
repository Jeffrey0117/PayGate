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
  `);

  return db;
}

module.exports = { getDb };
