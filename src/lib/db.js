import Database from 'better-sqlite3';

const db = new Database('sync.db');

db.pragma('journal_mode = WAL');

const initSql = `
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tiny_deposito_id TEXT NOT NULL UNIQUE,
  tiny_deposito_nome TEXT,
  shopify_location_id TEXT NOT NULL,
  shopify_location_name TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sku_cache (
  sku TEXT PRIMARY KEY,
  shopify_inventory_item_id TEXT NOT NULL,
  shopify_variant_id TEXT,
  product_title TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sync_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  context_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

db.exec(initSql);

const getConfigStmt = db.prepare('SELECT value FROM config WHERE key = ?');
const setConfigStmt = db.prepare(`
  INSERT INTO config (key, value, updated_at)
  VALUES (?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(key) DO UPDATE SET
    value = excluded.value,
    updated_at = CURRENT_TIMESTAMP
`);

export function getConfigValue(key, fallback = null) {
  const row = getConfigStmt.get(key);
  return row ? row.value : fallback;
}

export function setConfigValue(key, value) {
  setConfigStmt.run(key, String(value));
}

export function getConfigObject() {
  const rows = db.prepare('SELECT key, value FROM config').all();
  return rows.reduce((acc, row) => {
    acc[row.key] = row.value;
    return acc;
  }, {});
}

export function upsertMapping(mapping) {
  const stmt = db.prepare(`
    INSERT INTO mappings (
      tiny_deposito_id,
      tiny_deposito_nome,
      shopify_location_id,
      shopify_location_name,
      active,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(tiny_deposito_id) DO UPDATE SET
      tiny_deposito_nome = excluded.tiny_deposito_nome,
      shopify_location_id = excluded.shopify_location_id,
      shopify_location_name = excluded.shopify_location_name,
      active = excluded.active,
      updated_at = CURRENT_TIMESTAMP
  `);

  stmt.run(
    String(mapping.tiny_deposito_id),
    mapping.tiny_deposito_nome ?? '',
    String(mapping.shopify_location_id),
    mapping.shopify_location_name ?? '',
    mapping.active ? 1 : 0
  );
}

export function listMappings() {
  return db.prepare('SELECT * FROM mappings ORDER BY tiny_deposito_nome, tiny_deposito_id').all();
}

export function deleteMapping(tinyDepositoId) {
  db.prepare('DELETE FROM mappings WHERE tiny_deposito_id = ?').run(String(tinyDepositoId));
}

export function listActiveMappings() {
  return db.prepare('SELECT * FROM mappings WHERE active = 1').all();
}

export function getMappingByDeposito(tinyDepositoId) {
  return db.prepare('SELECT * FROM mappings WHERE tiny_deposito_id = ?').get(String(tinyDepositoId));
}

export function saveSkuCache(entry) {
  const stmt = db.prepare(`
    INSERT INTO sku_cache (
      sku,
      shopify_inventory_item_id,
      shopify_variant_id,
      product_title,
      updated_at
    ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(sku) DO UPDATE SET
      shopify_inventory_item_id = excluded.shopify_inventory_item_id,
      shopify_variant_id = excluded.shopify_variant_id,
      product_title = excluded.product_title,
      updated_at = CURRENT_TIMESTAMP
  `);

  stmt.run(
    entry.sku,
    entry.shopify_inventory_item_id,
    entry.shopify_variant_id ?? '',
    entry.product_title ?? ''
  );
}

export function getSkuCache(sku) {
  return db.prepare('SELECT * FROM sku_cache WHERE sku = ?').get(sku);
}

export function addLog({ type, status, message, context }) {
  const stmt = db.prepare(`
    INSERT INTO sync_logs (type, status, message, context_json)
    VALUES (?, ?, ?, ?)
  `);

  stmt.run(
    type,
    status,
    message ?? '',
    context ? JSON.stringify(context) : null
  );
}

export function listLogs(limit = 200) {
  const rows = db.prepare('SELECT * FROM sync_logs ORDER BY id DESC LIMIT ?').all(limit);
  return rows.map((row) => ({
    ...row,
    context: row.context_json ? JSON.parse(row.context_json) : null
  }));
}

export default db;
