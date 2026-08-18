'use strict';
/**
 * Data layer. Prototype uses node:sqlite so the whole thing runs with one
 * dependency and no external service.
 *
 * Table and column names follow README §3.1 verbatim so the Phase 2 migration
 * to Supabase (§3.2 / I-01) is a type change, not a rename.
 */
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS members (
  line_user_id  TEXT PRIMARY KEY,
  nickname      TEXT NOT NULL,
  display_name  TEXT,
  phone         TEXT,
  bound_at      TEXT,
  role          TEXT NOT NULL CHECK (role IN ('buyer','helper','packer','owner'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_members_nickname ON members (LOWER(TRIM(nickname)));

CREATE TABLE IF NOT EXISTS batches (
  batch      TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  opened_at  TEXT,
  closed_at  TEXT
);

CREATE TABLE IF NOT EXISTS products (
  sku             TEXT PRIMARY KEY,
  name_zh         TEXT NOT NULL,
  name_local      TEXT,
  brand           TEXT,
  price_twd       REAL NOT NULL,
  est_cost_jpy    REAL,
  actual_cost_jpy REAL,
  image_url       TEXT,
  batch           TEXT REFERENCES batches(batch),
  -- F-14 groundwork. Enforcement needs a real transactional DB (I-01);
  -- the prototype uses a SQLite transaction so the semantics are testable.
  stock_limit     INTEGER,
  reserved        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  order_id        TEXT PRIMARY KEY,
  line_user_id    TEXT NOT NULL REFERENCES members(line_user_id),
  batch           TEXT REFERENCES batches(batch),
  status          TEXT NOT NULL,
  total_twd       REAL NOT NULL DEFAULT 0,
  paid            INTEGER NOT NULL DEFAULT 0,
  paid_at         TEXT,
  parent_order_id TEXT REFERENCES orders(order_id),
  created_at      TEXT NOT NULL,
  note            TEXT
);

CREATE TABLE IF NOT EXISTS order_items (
  item_id          TEXT PRIMARY KEY,
  order_id         TEXT NOT NULL REFERENCES orders(order_id),
  sku              TEXT NOT NULL REFERENCES products(sku),
  qty              INTEGER NOT NULL,
  unit_price_twd   REAL NOT NULL,        -- price snapshot taken at order time
  source_image_url TEXT
);

CREATE TABLE IF NOT EXISTS order_status_log (
  log_id      TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL REFERENCES orders(order_id),
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor       TEXT,
  reason      TEXT,
  ts          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS procurements (
  proc_id       TEXT PRIMARY KEY,
  batch         TEXT NOT NULL,
  sku           TEXT NOT NULL REFERENCES products(sku),
  need_qty      INTEGER NOT NULL,
  claimed_by    TEXT REFERENCES members(line_user_id),
  claimed_at    TEXT,
  got_qty       INTEGER,
  state         TEXT NOT NULL CHECK (state IN ('open','claimed','got','partial','out_of_stock')),
  unit_cost_jpy REAL,
  fx_rate       REAL,                    -- rate snapshot, see F-23
  receipt_url   TEXT,
  amount_edited INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_proc_batch_sku ON procurements (batch, sku);

CREATE TABLE IF NOT EXISTS expenses (
  expense_id    TEXT PRIMARY KEY,
  proc_id       TEXT NOT NULL REFERENCES procurements(proc_id),
  qty           INTEGER NOT NULL,
  unit_cost_jpy REAL NOT NULL,
  fx_rate       REAL NOT NULL,
  receipt_url   TEXT,
  amount_edited INTEGER NOT NULL DEFAULT 0,
  created_by    TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  payment_id     TEXT PRIMARY KEY,
  order_id       TEXT NOT NULL REFERENCES orders(order_id),
  amount_twd     REAL NOT NULL,
  method         TEXT NOT NULL CHECK (method IN ('transfer','linepay','cash')),
  last5          TEXT,
  received_at    TEXT,
  reconciled_by  TEXT
);

CREATE TABLE IF NOT EXISTS shipments (
  shipment_id      TEXT PRIMARY KEY,
  order_id         TEXT NOT NULL REFERENCES orders(order_id),
  shipped_at       TEXT NOT NULL,
  verified_by_scan INTEGER NOT NULL DEFAULT 0,
  operator         TEXT,
  override_reason  TEXT
);

CREATE TABLE IF NOT EXISTS logistics_bindings (
  tracking_no TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL REFERENCES orders(order_id),
  carrier     TEXT,
  bound_at    TEXT,
  bound_by    TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  log_id TEXT PRIMARY KEY,
  ts     TEXT NOT NULL,
  actor  TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  result TEXT NOT NULL CHECK (result IN ('ok','warn','blocked'))
);

CREATE TABLE IF NOT EXISTS fx_history (
  fx_id      TEXT PRIMARY KEY,
  rate       REAL NOT NULL,
  changed_by TEXT,
  changed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  notif_id   TEXT PRIMARY KEY,
  audience   TEXT NOT NULL,          -- 'owner' | line_user_id
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT,
  target     TEXT,
  created_at TEXT NOT NULL,
  read_at    TEXT
);

CREATE TABLE IF NOT EXISTS idempotency (
  key        TEXT PRIMARY KEY,
  response   TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

let db = null;

function open() {
  if (db) return db;
  const file = config.dbPath;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

function get() {
  return db || open();
}

// --- small query helpers -------------------------------------------------

const all = (sql, ...params) => get().prepare(sql).all(...params).map(plain);
const one = (sql, ...params) => {
  const row = get().prepare(sql).get(...params);
  return row ? plain(row) : null;
};
const run = (sql, ...params) => get().prepare(sql).run(...params);
const tx = (fn) => {
  const d = get();
  d.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    d.exec('COMMIT');
    return out;
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
};

// node:sqlite returns null-prototype objects; normalise for JSON.stringify
const plain = (row) => Object.assign({}, row);

const setting = (key, fallback = null) => {
  const row = one('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : fallback;
};
const putSetting = (key, value) =>
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));

module.exports = { open, get, all, one, run, tx, setting, putSetting, SCHEMA };
