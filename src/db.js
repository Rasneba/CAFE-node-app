const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

let backend;

function nowIso() {
  return new Date().toISOString();
}

function toNumber(value) {
  if (typeof value === 'bigint') return Number(value);
  return value;
}

function createPostgres(databaseUrl) {
  const { Pool } = require('pg');
  const useSsl = process.env.DATABASE_SSL === 'false'
    ? false
    : /sslmode=(require|verify|prefer)/i.test(databaseUrl)
      ? { rejectUnauthorized: false }
      : undefined;

  const pool = new Pool({
    connectionString: databaseUrl,
    max: Number(process.env.DB_POOL_MAX || 5),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: true,
    ssl: useSsl,
  });
  pool.on('error', (error) => console.error('PostgreSQL pool error:', error.message));

  function convert(sql) {
    let index = 0;
    return sql.replace(/\?/g, () => `$${++index}`);
  }

  function wrap(client) {
    return {
      client,
      async all(sql, params = []) {
        const result = await client.query(convert(sql), params);
        return result.rows;
      },
      async get(sql, params = []) {
        const result = await client.query(convert(sql), params);
        return result.rows[0];
      },
      async run(sql, params = []) {
        const result = await client.query(convert(sql), params);
        return { changes: result.rowCount, lastInsertRowid: result.rows[0]?.id };
      },
      async exec(sql) {
        await client.query(sql);
      },
    };
  }

  const base = wrap(pool);

  return {
    kind: 'postgres',
    all: base.all,
    get: base.get,
    run: base.run,
    exec: base.exec,
    async tx(fn) {
      const client = await pool.connect();
      const tx = wrap(client);
      try {
        await client.query('BEGIN');
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

function createSqlite(file) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  database.exec('PRAGMA journal_mode = WAL;');
  database.exec('PRAGMA foreign_keys = ON;');

  function wrap(connection) {
    return {
      async all(sql, params = []) {
        return connection.prepare(sql).all(...params).map(normalizeRow);
      },
      async get(sql, params = []) {
        const row = connection.prepare(sql).get(...params);
        return row ? normalizeRow(row) : undefined;
      },
      async run(sql, params = []) {
        const result = connection.prepare(sql).run(...params);
        return { changes: result.changes, lastInsertRowid: toNumber(result.lastInsertRowid) };
      },
      async exec(sql) {
        connection.exec(sql);
      },
    };
  }

  function normalizeRow(row) {
    const output = {};
    for (const [key, value] of Object.entries(row)) output[key] = toNumber(value);
    return output;
  }

  const base = wrap(database);

  return {
    kind: 'sqlite',
    all: base.all,
    get: base.get,
    run: base.run,
    exec: base.exec,
    async tx(fn) {
      const tx = wrap(database);
      database.exec('BEGIN');
      try {
        const result = await fn(tx);
        database.exec('COMMIT');
        return result;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    async close() {
      database.close();
    },
  };
}

function getDb() {
  if (backend) return backend;
  if (config.databaseUrl) {
    backend = createPostgres(config.databaseUrl);
  } else {
    backend = createSqlite(config.sqliteFile);
  }
  return backend;
}

async function initDb() {
  const db = getDb();
  const schemaFile = db.kind === 'postgres' ? 'schema.postgres.sql' : 'schema.sqlite.sql';
  const schema = fs.readFileSync(path.join(__dirname, schemaFile), 'utf8');
  await db.exec(schema);

  if (db.kind === 'sqlite') {
    for (const statement of [
      'ALTER TABLE orders ADD COLUMN closed_at TEXT',
      'ALTER TABLE orders ADD COLUMN customer_id INTEGER',
      'ALTER TABLE orders ADD COLUMN reservation_id INTEGER',
      'ALTER TABLE orders ADD COLUMN cashier_id INTEGER',
      'ALTER TABLE orders ADD COLUMN waiter_id INTEGER',
      'ALTER TABLE orders ADD COLUMN invoice_id INTEGER',
      'ALTER TABLE orders ADD COLUMN inventory_deducted_at TEXT',
      'ALTER TABLE orders ADD COLUMN discount_reason TEXT',
      'ALTER TABLE orders ADD COLUMN void_reason TEXT',
      'ALTER TABLE payments ADD COLUMN voided_at TEXT',
      'ALTER TABLE payments ADD COLUMN received_by INTEGER',
      'ALTER TABLE payments ADD COLUMN shift_id INTEGER',
      'ALTER TABLE payments ADD COLUMN notes TEXT',
      'ALTER TABLE settings ADD COLUMN address TEXT',
      'ALTER TABLE settings ADD COLUMN phone TEXT',
      'ALTER TABLE settings ADD COLUMN email TEXT',
      'ALTER TABLE settings ADD COLUMN logo_url TEXT',
      'ALTER TABLE settings ADD COLUMN receipt_header TEXT',
      'ALTER TABLE settings ADD COLUMN invoice_prefix TEXT DEFAULT \'INV\'',
      'ALTER TABLE settings ADD COLUMN tax_number TEXT',
      'ALTER TABLE settings ADD COLUMN timezone TEXT',
      'ALTER TABLE settings ADD COLUMN deduct_stock_on_submit INTEGER DEFAULT 1',
      'ALTER TABLE settings ADD COLUMN low_stock_alerts INTEGER DEFAULT 1',
      'ALTER TABLE menu_items ADD COLUMN sku TEXT',
      'ALTER TABLE menu_items ADD COLUMN cost_price REAL DEFAULT 0',
      'ALTER TABLE menu_items ADD COLUMN taxable INTEGER DEFAULT 1',
      'ALTER TABLE menu_items ADD COLUMN barcode TEXT',
      'ALTER TABLE dining_tables ADD COLUMN branch_id INTEGER',
      'ALTER TABLE dining_tables ADD COLUMN floor_id INTEGER',
      'ALTER TABLE dining_tables ADD COLUMN section_id INTEGER',
      'ALTER TABLE dining_tables ADD COLUMN position_x INTEGER DEFAULT 0',
      'ALTER TABLE dining_tables ADD COLUMN position_y INTEGER DEFAULT 0',
      'ALTER TABLE order_items ADD COLUMN variant_id INTEGER',
      'ALTER TABLE order_items ADD COLUMN modifier_total REAL DEFAULT 0',
      'ALTER TABLE order_items ADD COLUMN cost_total REAL DEFAULT 0',
      'ALTER TABLE order_items ADD COLUMN discount_total REAL DEFAULT 0',
      'ALTER TABLE order_items ADD COLUMN served_at TEXT',
      'ALTER TABLE expenses ADD COLUMN supplier_id INTEGER',
      'ALTER TABLE expenses ADD COLUMN payment_method TEXT DEFAULT \'CASH\'',
      'ALTER TABLE expenses ADD COLUMN reference TEXT',
      'ALTER TABLE expenses ADD COLUMN recorded_by INTEGER',
      'ALTER TABLE expenses ADD COLUMN status TEXT DEFAULT \'POSTED\'',
      'ALTER TABLE refunds ADD COLUMN payment_id INTEGER',
      'ALTER TABLE refunds ADD COLUMN method_code TEXT DEFAULT \'CASH\'',
      'ALTER TABLE refunds ADD COLUMN processed_by INTEGER',
    ]) {
      try {
        await db.exec(statement);
      } catch {
        // Column already exists.
      }
    }
  }

  for (const [code, name] of [
    ['CASH', 'Cash'],
    ['CARD', 'Bank card'],
    ['TELEBIRR', 'telebirr'],
    ['MOBILE_MONEY', 'Mobile money'],
  ]) {
    await db.run(
      'INSERT INTO payment_methods (code, name) VALUES (?, ?) ON CONFLICT (code) DO NOTHING',
      [code, name],
    );
  }

  await db.run(
    `INSERT INTO settings
       (id, restaurant_name, currency, tax_rate, service_charge_rate, service_charge_enabled, tax_enabled, receipt_footer, updated_at)
     VALUES (1, ?, ?, ?, ?, 1, 1, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
    [
      config.restaurantName,
      config.currency,
      config.taxRate,
      config.serviceChargeRate,
      'Thank you for dining with us.',
      nowIso(),
    ],
  );
  return db;
}

async function getSetting(key, fallback = null) {
  const db = getDb();
  const row = await db.get('SELECT value FROM sync_state WHERE key = ?', [key]);
  return row ? row.value : fallback;
}

async function setSetting(key, value) {
  const db = getDb();
  await db.run(
    `INSERT INTO sync_state (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [key, value == null ? null : String(value)],
  );
}

module.exports = { getDb, initDb, nowIso, getSetting, setSetting };
