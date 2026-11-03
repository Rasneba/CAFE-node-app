const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const QRCode = require('qrcode');
const config = require('./config');
const { initDb, nowIso } = require('./db');
const { seedDemoData } = require('./seed');
const { seedErpData } = require('./seed-erp');
const { createReportService } = require('./reports/reportService');
const { createReportsRouter } = require('./reports/routes');
const { createAuthRouter } = require('./erp');
const { authMiddleware, requireAuth } = require('./auth');
const { rateLimit } = require('./rateLimit');

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

function safeEqual(left, right) {
  const a = Buffer.from(String(left == null ? '' : left));
  const b = Buffer.from(String(right == null ? '' : right));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requireDevice(req, res, next) {
  if (!config.deviceApiKey) {
    return res.status(503).json({ error: { message: 'DEVICE_API_KEY is not configured on the server.' } });
  }
  if (!safeEqual(req.headers['x-device-key'], config.deviceApiKey)) {
    return res.status(401).json({ error: { message: 'Invalid device key.' } });
  }
  return next();
}

function requireAdmin(req, res, next) {
  if (req.user && (req.isSuperAdmin || req.permissions.includes('*') || req.permissions.includes('settings.manage'))) {
    return next();
  }
  if (!config.adminPassword) {
    return res.status(503).json({ error: { message: 'ADMIN_PASSWORD is not configured on the server.' } });
  }
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) {
    res.set('WWW-Authenticate', 'Basic realm="Restaurant Admin"');
    return res.status(401).json({ error: { message: 'Authentication required.' } });
  }
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  const username = separator === -1 ? decoded : decoded.slice(0, separator);
  const password = separator === -1 ? '' : decoded.slice(separator + 1);
  if (!safeEqual(username, config.adminUsername) || !safeEqual(password, config.adminPassword)) {
    res.set('WWW-Authenticate', 'Basic realm="Restaurant Admin"');
    return res.status(401).json({ error: { message: 'Invalid credentials.' } });
  }
  return next();
}

function mapItem(row) {
  return {
    id: row.id,
    uuid: row.sync_id,
    name: row.name,
    nameAm: row.name_am,
    category: row.category_name || 'Uncategorised',
    categoryId: row.category_id,
    categoryUuid: row.category_sync_id,
    price: Number(row.price),
    station: row.station,
    image: row.image_url,
    desc: row.description || '',
    available: Boolean(row.available) && !row.sold_out,
    soldOut: Boolean(row.sold_out),
    featured: Boolean(row.featured),
    sortOrder: row.sort_order,
  };
}

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

async function upsertOrder(db, order) {
  const stamp = nowIso();
  const closedAt = order.status === 'PAID' ? (order.updatedAt || order.createdAt || stamp) : null;
  await db.run(
    `INSERT INTO orders
       (sync_id, order_number, type, source, status, table_id, table_sync_id, guest_count, subtotal,
        discount_total, tax_total, service_total, total, paid_total, notes, idempotency_key,
        device_id, created_at, updated_at, closed_at, synced_at, deleted)
     VALUES (?, ?, ?, ?, ?, (SELECT id FROM dining_tables WHERE sync_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT (sync_id) DO UPDATE SET
       order_number = excluded.order_number,
       type = excluded.type,
       source = excluded.source,
       status = excluded.status,
       table_id = excluded.table_id,
       table_sync_id = excluded.table_sync_id,
       guest_count = excluded.guest_count,
       subtotal = excluded.subtotal,
       discount_total = excluded.discount_total,
       tax_total = excluded.tax_total,
       service_total = excluded.service_total,
       total = excluded.total,
       paid_total = excluded.paid_total,
       notes = excluded.notes,
       idempotency_key = excluded.idempotency_key,
       device_id = excluded.device_id,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       closed_at = COALESCE(orders.closed_at, excluded.closed_at),
       synced_at = excluded.synced_at`,
    [
      order.syncId,
      order.orderNumber,
      order.type || 'DINE_IN',
      order.source || 'STAFF',
      order.status || 'SUBMITTED',
      order.tableSyncId || null,
      order.tableSyncId || null,
      Number(order.guestCount || 1),
      Number(order.subtotal || 0),
      Number(order.discountTotal || 0),
      Number(order.taxTotal || 0),
      Number(order.serviceTotal || 0),
      Number(order.total || 0),
      Number(order.paidTotal || 0),
      order.notes || null,
      order.idempotencyKey || null,
      order.deviceId || config.deviceId,
      order.createdAt || stamp,
      order.updatedAt || stamp,
      closedAt,
      stamp,
    ],
  );

  const cloudOrder = await db.get('SELECT id FROM orders WHERE sync_id = ?', [order.syncId]);
  if (!cloudOrder) throw new Error(`Order ${order.syncId} could not be stored.`);

  for (const item of order.items || []) {
    await db.run(
      `INSERT INTO order_items
         (sync_id, order_id, order_sync_id, menu_item_id, menu_item_sync_id, name, quantity, unit_price,
          line_total, notes, station, status, created_at, synced_at, deleted)
       VALUES (?, ?, ?, (SELECT id FROM menu_items WHERE sync_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT (sync_id) DO UPDATE SET
         order_id = excluded.order_id,
         order_sync_id = excluded.order_sync_id,
         menu_item_id = excluded.menu_item_id,
         menu_item_sync_id = excluded.menu_item_sync_id,
         name = excluded.name,
         quantity = excluded.quantity,
         unit_price = excluded.unit_price,
         line_total = excluded.line_total,
         notes = excluded.notes,
         station = excluded.station,
         status = excluded.status,
         synced_at = excluded.synced_at`,
      [
        item.syncId,
        cloudOrder.id,
        order.syncId,
        item.menuItemSyncId || null,
        item.menuItemSyncId || null,
        item.name,
        Number(item.quantity || 1),
        Number(item.unitPrice || 0),
        Number(item.lineTotal || 0),
        item.notes || null,
        item.station || 'Kitchen',
        item.status || 'PENDING',
        item.createdAt || order.createdAt || stamp,
        stamp,
      ],
    );
  }

  for (const payment of order.payments || []) {
    await db.run(
      `INSERT INTO payments
         (sync_id, order_id, order_sync_id, receipt_number, method_code, amount, tendered,
          change_due, reference, created_at, synced_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT (sync_id) DO UPDATE SET
         order_id = excluded.order_id,
         order_sync_id = excluded.order_sync_id,
         receipt_number = excluded.receipt_number,
         method_code = excluded.method_code,
         amount = excluded.amount,
         tendered = excluded.tendered,
         change_due = excluded.change_due,
         reference = excluded.reference,
         synced_at = excluded.synced_at`,
      [
        payment.syncId,
        cloudOrder.id,
        order.syncId,
        payment.receiptNumber,
        payment.methodCode || 'CASH',
        Number(payment.amount || 0),
        payment.tendered == null ? null : Number(payment.tendered),
        payment.changeDue == null ? null : Number(payment.changeDue),
        payment.reference || null,
        payment.createdAt || stamp,
        stamp,
      ],
    );
  }

  return cloudOrder.id;
}

async function applyOrderUpdate(db, update) {
  const stamp = nowIso();
  const closedAt = update.status === 'PAID' ? (update.updatedAt || stamp) : null;
  await db.run(
    `UPDATE orders SET
       status = COALESCE(?, status),
       paid_total = COALESCE(?, paid_total),
       updated_at = ?,
       closed_at = COALESCE(?, closed_at),
       synced_at = ?
     WHERE sync_id = ?`,
    [
      update.status || null,
      update.paidTotal == null ? null : Number(update.paidTotal),
      stamp,
      closedAt,
      stamp,
      update.syncId,
    ],
  );

  for (const item of update.items || []) {
    if (!item.syncId) continue;
    await db.run(
      'UPDATE order_items SET status = COALESCE(?, status), synced_at = ? WHERE sync_id = ?',
      [item.status || null, stamp, item.syncId],
    );
  }

  for (const payment of update.payments || []) {
    if (!payment.syncId) continue;
    await db.run(
      `UPDATE payments SET amount = COALESCE(?, amount), method_code = COALESCE(?, method_code),
         receipt_number = COALESCE(?, receipt_number), synced_at = ? WHERE sync_id = ?`,
      [payment.amount == null ? null : Number(payment.amount),
       payment.methodCode || null,
       payment.receiptNumber || null,
       stamp, payment.syncId],
    );
  }
}

async function applyOutbox(db, entry) {
  const payload = entry.payload || {};
  const stamp = nowIso();
  if (entry.entity === 'menu_category') {
    if (entry.op === 'delete') {
      await db.run('UPDATE menu_categories SET deleted = 1, updated_at = ? WHERE sync_id = ?', [stamp, payload.syncId]);
      return;
    }
    await db.run(
      `INSERT INTO menu_categories (sync_id, name, sort, active, updated_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (sync_id) DO UPDATE SET
         name = excluded.name,
         sort = excluded.sort,
         active = excluded.active,
         updated_at = excluded.updated_at,
         deleted = excluded.deleted`,
      [
        payload.syncId,
        payload.name,
        Number(payload.sort || 0),
        payload.active === false ? 0 : 1,
        payload.updatedAt || stamp,
        payload.deleted ? 1 : 0,
      ],
    );
    return;
  }

  if (entry.entity === 'menu_item') {
    if (entry.op === 'delete') {
      await db.run('UPDATE menu_items SET deleted = 1, updated_at = ? WHERE sync_id = ?', [stamp, payload.syncId]);
      return;
    }
    await db.run(
      `INSERT INTO menu_items
         (sync_id, category_id, category_sync_id, name, description, price, image_url, station,
          available, sold_out, featured, sort_order, updated_at, deleted)
       VALUES (?, (SELECT id FROM menu_categories WHERE sync_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (sync_id) DO UPDATE SET
         category_id = excluded.category_id,
         category_sync_id = excluded.category_sync_id,
         name = excluded.name,
         description = excluded.description,
         price = excluded.price,
         image_url = excluded.image_url,
         station = excluded.station,
         available = excluded.available,
         sold_out = excluded.sold_out,
         featured = excluded.featured,
         sort_order = excluded.sort_order,
         updated_at = excluded.updated_at,
         deleted = excluded.deleted`,
      [
        payload.syncId,
        payload.categorySyncId || null,
        payload.categorySyncId || null,
        payload.name,
        payload.description || null,
        Number(payload.price || 0),
        payload.imageUrl || null,
        payload.station || 'Kitchen',
        payload.available === false ? 0 : 1,
        payload.soldOut ? 1 : 0,
        payload.featured ? 1 : 0,
        Number(payload.sortOrder || 0),
        payload.updatedAt || stamp,
        payload.deleted ? 1 : 0,
      ],
    );
    return;
  }

  if (entry.entity === 'table') {
    await db.run(
      `INSERT INTO dining_tables (sync_id, number, name, capacity, status, qr_token, updated_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (sync_id) DO UPDATE SET
         number = excluded.number,
         name = excluded.name,
         capacity = excluded.capacity,
         status = excluded.status,
         qr_token = excluded.qr_token,
         updated_at = excluded.updated_at,
         deleted = excluded.deleted`,
      [
        payload.syncId,
        payload.number,
        payload.name,
        Number(payload.capacity || 4),
        payload.status || 'AVAILABLE',
        payload.qrToken || null,
        payload.updatedAt || stamp,
        payload.deleted ? 1 : 0,
      ],
    );
    return;
  }

  if (entry.entity === 'settings') {
    await db.run(
      `UPDATE settings SET
         restaurant_name = COALESCE(?, restaurant_name),
         currency = COALESCE(?, currency),
         tax_rate = COALESCE(?, tax_rate),
         service_charge_rate = COALESCE(?, service_charge_rate),
         service_charge_enabled = COALESCE(?, service_charge_enabled),
         tax_enabled = COALESCE(?, tax_enabled),
         receipt_footer = COALESCE(?, receipt_footer),
         updated_at = ?
       WHERE id = 1`,
      [
        payload.restaurantName ?? null,
        payload.currency ?? null,
        payload.taxRate ?? null,
        payload.serviceChargeRate ?? null,
        payload.serviceChargeEnabled == null ? null : (payload.serviceChargeEnabled ? 1 : 0),
        payload.taxEnabled == null ? null : (payload.taxEnabled ? 1 : 0),
        payload.receiptFooter ?? null,
        payload.updatedAt || stamp,
      ],
    );
  }
}

async function listCloudOrders(db, limit = 80) {
  const rows = await db.all(
    `SELECT o.*, t.number AS table_number
     FROM orders o LEFT JOIN dining_tables t ON t.sync_id = o.table_sync_id
     WHERE o.deleted = 0 ORDER BY o.id DESC LIMIT ?`,
    [limit],
  );
  const orders = [];
  for (const row of rows) {
    const items = await db.all('SELECT * FROM order_items WHERE order_sync_id = ? ORDER BY id ASC', [row.sync_id]);
    const payments = await db.all('SELECT * FROM payments WHERE order_sync_id = ? ORDER BY id ASC', [row.sync_id]);
    orders.push({
      id: row.id,
      uuid: row.sync_id,
      orderNumber: row.order_number,
      type: row.type,
      source: row.source,
      status: row.status,
      tableNumber: row.table_number || null,
      guestCount: row.guest_count,
      subtotal: Number(row.subtotal),
      discountTotal: Number(row.discount_total),
      taxTotal: Number(row.tax_total),
      serviceTotal: Number(row.service_total),
      total: Number(row.total),
      paidTotal: Number(row.paid_total),
      notes: row.notes,
      deviceId: row.device_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      closedAt: row.closed_at,
      items: items.map((item) => ({
        id: item.id,
        uuid: item.sync_id,
        name: item.name,
        quantity: item.quantity,
        unitPrice: Number(item.unit_price),
        lineTotal: Number(item.line_total),
        station: item.station,
        status: item.status,
        notes: item.notes,
      })),
      payments: payments.map((payment) => ({
        id: payment.id,
        uuid: payment.sync_id,
        receiptNumber: payment.receipt_number,
        methodCode: payment.method_code,
        amount: Number(payment.amount),
        createdAt: payment.created_at,
      })),
    });
  }
  return orders;
}

async function listMenu(db) {
  const categories = await db.all('SELECT * FROM menu_categories WHERE deleted = 0 ORDER BY sort, id');
  const items = await db.all(
    `SELECT i.*, c.name AS category_name
     FROM menu_items i LEFT JOIN menu_categories c ON c.id = i.category_id
     WHERE i.deleted = 0 ORDER BY c.sort, i.sort_order, i.id`,
  );
  return {
    categories: categories.map((row) => ({ id: row.id, uuid: row.sync_id, name: row.name, sort: row.sort })),
    items: items.map(mapItem),
  };
}

function createCloudApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '2mb' }));
  app.use((req, res, next) => {
    if (req.path === '/admin.html' || req.path === '/index.html') return res.status(404).end();
    return next();
  });
  app.use('/assets', express.static(path.join(config.root, 'public', 'assets'), { maxAge: '1h' }));
  app.use(express.static(path.join(config.root, 'public'), { maxAge: '1h' }));
  app.use(authMiddleware);
  app.use('/api/auth', createAuthRouter(db));

  app.use('/api/public/menu', rateLimit({ windowMs: 60_000, max: 120 }));
  app.use('/api/public/orders', rateLimit({ windowMs: 60_000, max: 30 }));

  const reportService = createReportService({
    databaseUrl: config.databaseUrl,
    currency: config.currency,
    timeZone: config.timeZone,
  });

  app.get('/api/health', asyncRoute(async (req, res) => {
    await db.get('SELECT 1 AS ok');
    res.json({ status: 'ok', mode: 'cloud', database: db.kind, time: nowIso() });
  }));

  app.get('/api/public/menu', asyncRoute(async (req, res) => {
    const token = req.query.t ? String(req.query.t) : null;
    const table = token ? await db.get('SELECT * FROM dining_tables WHERE qr_token = ? AND deleted = 0', [token]) : null;
    const settings = await db.get('SELECT * FROM settings WHERE id = 1');
    const categories = await db.all('SELECT * FROM menu_categories WHERE deleted = 0 AND active = 1 ORDER BY sort, id');
    const items = await db.all(
      `SELECT i.*, c.name AS category_name
       FROM menu_items i LEFT JOIN menu_categories c ON c.id = i.category_id
       WHERE i.deleted = 0 AND i.available = 1 AND i.sold_out = 0
       ORDER BY c.sort, i.sort_order, i.id`,
    );
    res.json({
      settings: {
        restaurantName: settings.restaurant_name,
        currency: settings.currency,
        receiptFooter: settings.receipt_footer,
      },
      table: table ? { number: table.number, name: table.name } : null,
      categories: categories.map((row) => ({ id: row.id, name: row.name })),
      items: items.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        price: Number(row.price),
        image: row.image_url,
        category: row.category_name,
        featured: Boolean(row.featured),
      })),
    });
  }));

  app.post('/api/public/orders', asyncRoute(async (req, res) => {
    const body = req.body || {};
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) {
      return res.status(400).json({ error: { message: 'Add at least one item to the order.' } });
    }
    const settings = await db.get('SELECT * FROM settings WHERE id = 1');
    const now = nowIso();
    const orderSyncId = crypto.randomUUID();
    const orderNumber = `WEB-${String(Date.now()).slice(-8)}`;

    const subtotal = money(items.reduce((sum, line) => sum + (Number(line.unitPrice || 0) * Number(line.quantity || 1)), 0));
    const taxTotal = settings.tax_enabled ? money(subtotal * Number(settings.tax_rate) / 100) : 0;
    const serviceTotal = settings.service_charge_enabled ? money(subtotal * Number(settings.service_charge_rate) / 100) : 0;
    const total = money(subtotal + taxTotal + serviceTotal);

    let customerId = null;
    if (body.customerPhone || body.customerEmail) {
      const existing = body.customerEmail
        ? await db.get('SELECT id FROM customers WHERE email = ? AND deleted = 0', [body.customerEmail])
        : await db.get('SELECT id FROM customers WHERE phone = ? AND deleted = 0', [body.customerPhone]);
      if (existing) {
        customerId = existing.id;
      } else {
        const cust = await db.get(
          `INSERT INTO customers (sync_id, name, phone, email, address, tax_number, loyalty_points, visits, total_spent, notes, created_at, updated_at, deleted)
           VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, 0) RETURNING id`,
          [crypto.randomUUID(), body.customerName || 'Walk-in Customer', body.customerPhone || null, body.customerEmail || null, body.customerAddress || null, body.customerTaxNumber || null, null, now, now],
        );
        customerId = cust.id;
      }
    }

    const table = body.tableSyncId ? await db.get('SELECT * FROM dining_tables WHERE sync_id = ? AND deleted = 0', [body.tableSyncId]) : null;

    let orderId;
    await db.tx(async (tx) => {
      const inserted = await tx.run(
        `INSERT INTO orders
           (sync_id, order_number, type, source, status, table_id, table_sync_id, guest_count, subtotal,
            discount_total, tax_total, service_total, total, paid_total, notes, idempotency_key,
            device_id, created_at, updated_at, synced_at, customer_id, deleted)
         VALUES (?, ?, 'ONLINE', 'ONLINE', 'SUBMITTED', ?, ?, ?, ?, 0, ?, ?, ?, 0, ?, null, 'online-portal', ?, ?, NULL, ?, 0) RETURNING id`,
        [
          orderSyncId,
          orderNumber,
          table ? table.id : null,
          body.tableSyncId || null,
          Number(body.guestCount || 1),
          subtotal,
          taxTotal,
          serviceTotal,
          total,
          body.notes || null,
          now,
          now,
          customerId,
        ],
      );
      orderId = inserted.lastInsertRowid;

      for (const line of items) {
        const menuItem = await tx.get('SELECT * FROM menu_items WHERE sync_id = ? AND deleted = 0', [line.menuItemSyncId]);
        await tx.run(
          `INSERT INTO order_items
             (sync_id, order_id, order_sync_id, menu_item_id, menu_item_sync_id, name, quantity,
              unit_price, line_total, notes, station, status, created_at, synced_at, deleted)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, NULL, 0)`,
          [
            crypto.randomUUID(),
            orderId,
            orderSyncId,
            menuItem ? menuItem.id : null,
            line.menuItemSyncId || null,
            line.name,
            Number(line.quantity || 1),
            Number(line.unitPrice || 0),
            Number(line.lineTotal || 0),
            line.notes || null,
            line.station || 'Kitchen',
            now,
          ],
        );
      }
    });

    const cloudOrder = await db.get('SELECT * FROM orders WHERE sync_id = ?', [orderSyncId]);
    res.status(201).json({
      ok: true,
      order: {
        syncId: cloudOrder.sync_id,
        orderNumber: cloudOrder.order_number,
        status: cloudOrder.status,
        total: Number(cloudOrder.total),
        createdAt: cloudOrder.created_at,
        customerId,
      },
    });
  }));
  app.post('/api/sync/push', requireDevice, asyncRoute(async (req, res) => {
    const { orders = [], orderUpdates = [], outbox = [] } = req.body || {};
    const accepted = [];
    const acceptedUpdates = [];
    const acceptedOutbox = [];
    for (const order of orders) {
      if (!order?.syncId) continue;
      await upsertOrder(db, order);
      accepted.push(order.syncId);
    }
    for (const update of orderUpdates) {
      if (!update?.syncId) continue;
      await applyOrderUpdate(db, update);
      acceptedUpdates.push(update.syncId);
    }
    for (const entry of outbox) {
      if (!entry?.entity) continue;
      await applyOutbox(db, entry);
      if (entry.id != null) acceptedOutbox.push(entry.id);
    }
    res.json({ ok: true, accepted, acceptedUpdates, acceptedOutbox });
  }));

  app.get('/api/sync/pull', requireDevice, asyncRoute(async (req, res) => {
    const since = String(req.query.since || '1970-01-01T00:00:00.000Z');
    const categories = await db.all('SELECT * FROM menu_categories WHERE updated_at > ? ORDER BY sort, id', [since]);
    const items = await db.all('SELECT * FROM menu_items WHERE updated_at > ? ORDER BY sort_order, id', [since]);
    const tables = await db.all('SELECT * FROM dining_tables WHERE updated_at > ? ORDER BY number', [since]);
    const settings = await db.get('SELECT * FROM settings WHERE id = 1');

    const newOrders = await db.all(
      `SELECT o.*, t.number AS table_number
       FROM orders o LEFT JOIN dining_tables t ON t.sync_id = o.table_sync_id
       WHERE o.source = 'ONLINE' AND o.deleted = 0 AND o.created_at > ?
       ORDER BY o.created_at ASC LIMIT 100`,
      [since],
    );
    const ordersPayload = [];
    for (const row of newOrders) {
      const items = await db.all('SELECT * FROM order_items WHERE order_sync_id = ? ORDER BY id ASC', [row.sync_id]);
      const payments = await db.all('SELECT * FROM payments WHERE order_sync_id = ? ORDER BY id ASC', [row.sync_id]);
      ordersPayload.push({
        syncId: row.sync_id,
        orderNumber: row.order_number,
        type: row.type,
        source: row.source,
        status: row.status,
        tableSyncId: row.table_sync_id,
        guestCount: row.guest_count,
        subtotal: Number(row.subtotal),
        discountTotal: Number(row.discount_total),
        taxTotal: Number(row.tax_total),
        serviceTotal: Number(row.service_total),
        total: Number(row.total),
        paidTotal: Number(row.paid_total),
        notes: row.notes,
        idempotencyKey: row.idempotency_key,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        customerId: row.customer_id,
        items: items.map((item) => ({
          syncId: item.sync_id,
          menuItemSyncId: item.menu_item_sync_id,
          name: item.name,
          quantity: item.quantity,
          unitPrice: Number(item.unit_price),
          lineTotal: Number(item.line_total),
          notes: item.notes,
          station: item.station,
          status: item.status,
          createdAt: item.created_at,
        })),
        payments: payments.map((payment) => ({
          syncId: payment.sync_id,
          receiptNumber: payment.receipt_number,
          methodCode: payment.method_code,
          amount: Number(payment.amount),
          tendered: payment.tendered == null ? null : Number(payment.tendered),
          changeDue: payment.change_due == null ? null : Number(payment.change_due),
          reference: payment.reference,
          createdAt: payment.created_at,
        })),
      });
    }

    res.json({
      serverTime: nowIso(),
      categories: categories.map((row) => ({
        syncId: row.sync_id,
        name: row.name,
        nameAm: row.name_am,
        sort: Number(row.sort),
        active: Boolean(row.active),
        updatedAt: row.updated_at,
        deleted: Boolean(row.deleted),
      })),
      items: items.map((row) => ({
        syncId: row.sync_id,
        categorySyncId: row.category_sync_id,
        name: row.name,
        nameAm: row.name_am,
        description: row.description,
        price: Number(row.price),
        imageUrl: row.image_url,
        station: row.station,
        available: Boolean(row.available),
        soldOut: Boolean(row.sold_out),
        featured: Boolean(row.featured),
        sortOrder: Number(row.sort_order),
        updatedAt: row.updated_at,
        deleted: Boolean(row.deleted),
      })),
      tables: tables.map((row) => ({
        syncId: row.sync_id,
        number: row.number,
        name: row.name,
        capacity: Number(row.capacity),
        status: row.status,
        qrToken: row.qr_token,
        updatedAt: row.updated_at,
        deleted: Boolean(row.deleted),
      })),
      orders: ordersPayload,
      settings: {
        restaurantName: settings.restaurant_name,
        currency: settings.currency,
        taxRate: Number(settings.tax_rate),
        serviceChargeRate: Number(settings.service_charge_rate),
        serviceChargeEnabled: Boolean(settings.service_charge_enabled),
        taxEnabled: Boolean(settings.tax_enabled),
        receiptFooter: settings.receipt_footer,
        updatedAt: settings.updated_at,
      },
    });
  }));

  app.get('/api/admin/summary', requireAdmin, asyncRoute(async (req, res) => {
    const counts = await db.get(
      `SELECT
         (SELECT COUNT(*) FROM orders WHERE deleted = 0) AS orders,
         (SELECT COUNT(*) FROM orders WHERE deleted = 0 AND status = 'PAID') AS paid_orders,
         (SELECT COALESCE(SUM(total), 0) FROM orders WHERE deleted = 0 AND status = 'PAID') AS sales,
         (SELECT COUNT(*) FROM menu_items WHERE deleted = 0) AS menu_items,
         (SELECT COUNT(*) FROM dining_tables WHERE deleted = 0) AS tables,
         (SELECT MAX(created_at) FROM orders WHERE deleted = 0) AS last_order_at`,
    );
    res.json({
      orders: Number(counts.orders),
      paidOrders: Number(counts.paid_orders),
      sales: Number(counts.sales),
      menuItems: Number(counts.menu_items),
      tables: Number(counts.tables),
      lastOrderAt: counts.last_order_at,
    });
  }));

  app.get('/api/admin/orders', requireAdmin, asyncRoute(async (req, res) => {
    res.json({ orders: await listCloudOrders(db, Math.min(Number(req.query.limit || 80), 200)) });
  }));

  app.get('/api/kitchen', requireAdmin, asyncRoute(async (req, res) => {
    const orders = await listCloudOrders(db, 100);
    res.json({
      orders: orders
        .filter((order) => ['COMPLETED', 'CANCELLED', 'VOID'].indexOf(String(order.status).toUpperCase()) === -1)
        .map((order) => ({
          ...order,
          items: order.items.filter((item) => ['PENDING', 'PREPARING', 'READY'].indexOf(item.status) !== -1),
        }))
        .filter((order) => order.items.length > 0),
    });
  }));

  app.post('/api/kitchen/items/:syncId/status', requireAdmin, asyncRoute(async (req, res) => {
    const item = await db.get('SELECT * FROM order_items WHERE sync_id = ?', [req.params.syncId]);
    if (!item) return res.status(404).json({ error: { message: 'Order item not found.' } });
    const status = String(req.body?.status || 'READY').toUpperCase();
    await db.run('UPDATE order_items SET status = ? WHERE id = ?', [status, item.id]);
    const siblings = await db.all('SELECT status FROM order_items WHERE order_sync_id = ?', [item.order_sync_id]);
    const allReady = siblings.every((row) => ['READY', 'SERVED'].indexOf(row.status) !== -1);
    const allServed = siblings.every((row) => row.status === 'SERVED');
    const orderStatus = allServed ? 'COMPLETED' : allReady ? 'READY' : 'PREPARING';
    await db.run('UPDATE orders SET status = ?, updated_at = ? WHERE sync_id = ?', [orderStatus, nowIso(), item.order_sync_id]);
    res.json({ itemId: item.id, status, orderStatus });
  }));

  app.get('/api/admin/menu', requireAdmin, asyncRoute(async (req, res) => {
    res.json(await listMenu(db));
  }));

  app.post('/api/admin/menu/items', requireAdmin, asyncRoute(async (req, res) => {
    const body = req.body || {};
    if (!body.name || body.price == null) {
      return res.status(400).json({ error: { message: 'Name and price are required.' } });
    }
    const category = body.categoryId
      ? await db.get('SELECT * FROM menu_categories WHERE id = ?', [Number(body.categoryId)])
      : null;
    if (!category) return res.status(400).json({ error: { message: 'Choose a category.' } });
    const now = nowIso();
    let item;
    if (body.id) {
      item = await db.get('SELECT * FROM menu_items WHERE id = ?', [Number(body.id)]);
      if (!item) return res.status(404).json({ error: { message: 'Menu item not found.' } });
      await db.run(
        `UPDATE menu_items SET category_id = ?, category_sync_id = ?, name = ?, description = ?, price = ?,
           image_url = ?, station = ?, available = ?, sold_out = ?, featured = ?, updated_at = ?
         WHERE id = ?`,
        [
          category.id,
          category.sync_id,
          body.name,
          body.description || '',
          Number(body.price),
          body.image || null,
          body.station || 'Kitchen',
          body.available === false ? 0 : 1,
          body.soldOut ? 1 : 0,
          body.featured ? 1 : 0,
          now,
          item.id,
        ],
      );
      item = await db.get('SELECT * FROM menu_items WHERE id = ?', [item.id]);
    } else {
      item = await db.get(
        `INSERT INTO menu_items
           (sync_id, category_id, category_sync_id, name, description, price, image_url, station,
            available, sold_out, featured, sort_order, updated_at, deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0) RETURNING *`,
        [
          crypto.randomUUID(),
          category.id,
          category.sync_id,
          body.name,
          body.description || '',
          Number(body.price),
          body.image || null,
          body.station || 'Kitchen',
          body.available === false ? 0 : 1,
          body.soldOut ? 1 : 0,
          body.featured ? 1 : 0,
          Number(body.sortOrder || 0),
          now,
        ],
      );
    }
    res.json({ item: mapItem({ ...item, category_name: category.name }) });
  }));

  app.delete('/api/admin/menu/items/:id', requireAdmin, asyncRoute(async (req, res) => {
    const item = await db.get('SELECT * FROM menu_items WHERE id = ?', [Number(req.params.id)]);
    if (!item) return res.status(404).json({ error: { message: 'Menu item not found.' } });
    await db.run('UPDATE menu_items SET deleted = 1, updated_at = ? WHERE id = ?', [nowIso(), item.id]);
    res.json({ ok: true });
  }));

  app.post('/api/admin/menu/categories', requireAdmin, asyncRoute(async (req, res) => {
    const body = req.body || {};
    if (!body.name) return res.status(400).json({ error: { message: 'Category name is required.' } });
    const now = nowIso();
    let category;
    if (body.id) {
      category = await db.get('SELECT * FROM menu_categories WHERE id = ?', [Number(body.id)]);
      if (!category) return res.status(404).json({ error: { message: 'Category not found.' } });
      await db.run('UPDATE menu_categories SET name = ?, sort = ?, updated_at = ? WHERE id = ?', [
        body.name,
        Number(body.sort || 0),
        now,
        category.id,
      ]);
      category = await db.get('SELECT * FROM menu_categories WHERE id = ?', [category.id]);
    } else {
      category = await db.get(
        `INSERT INTO menu_categories (sync_id, name, sort, active, updated_at, deleted)
         VALUES (?, ?, ?, 1, ?, 0) RETURNING *`,
        [crypto.randomUUID(), body.name, Number(body.sort || 0), now],
      );
    }
    res.json({ category: { id: category.id, uuid: category.sync_id, name: category.name, sort: category.sort } });
  }));

  app.get('/api/admin/settings', requireAdmin, asyncRoute(async (req, res) => {
    const settings = await db.get('SELECT * FROM settings WHERE id = 1');
    res.json({
      settings: {
        restaurantName: settings.restaurant_name,
        currency: settings.currency,
        taxRate: Number(settings.tax_rate),
        serviceChargeRate: Number(settings.service_charge_rate),
        serviceChargeEnabled: Boolean(settings.service_charge_enabled),
        taxEnabled: Boolean(settings.tax_enabled),
        receiptFooter: settings.receipt_footer,
      },
    });
  }));

  app.post('/api/admin/settings', requireAdmin, asyncRoute(async (req, res) => {
    const body = req.body || {};
    const settings = await db.get('SELECT * FROM settings WHERE id = 1');
    await db.run(
      `UPDATE settings SET restaurant_name = ?, currency = ?, tax_rate = ?, service_charge_rate = ?,
         service_charge_enabled = ?, tax_enabled = ?, receipt_footer = ?, updated_at = ? WHERE id = 1`,
      [
        body.restaurantName || settings.restaurant_name,
        String(body.currency || settings.currency).toUpperCase(),
        body.taxRate == null ? Number(settings.tax_rate) : Number(body.taxRate),
        body.serviceChargeRate == null ? Number(settings.service_charge_rate) : Number(body.serviceChargeRate),
        body.serviceChargeEnabled == null ? Number(settings.service_charge_enabled) : (body.serviceChargeEnabled ? 1 : 0),
        body.taxEnabled == null ? Number(settings.tax_enabled) : (body.taxEnabled ? 1 : 0),
        body.receiptFooter == null ? settings.receipt_footer : body.receiptFooter,
        nowIso(),
      ],
    );
    res.json({ ok: true });
  }));

  const qrHandler = asyncRoute(async (req, res) => {
    const origin = config.publicUrl || `${req.protocol}://${req.get('host')}`;
    const text = String(req.query.text || `${origin}/menu`);
    const buffer = await QRCode.toBuffer(text, { width: 560, margin: 1, color: { dark: '#1f2a20', light: '#ffffff' } });
    res.type('png').send(buffer);
  });
  app.get('/api/admin/qr', requireAdmin, qrHandler);
  app.get('/api/qr', requireAdmin, qrHandler);

  app.use('/api/reports', requireAdmin, createReportsRouter(reportService, { timeZone: config.timeZone }));

  app.get('/menu', (req, res) => res.sendFile(path.join(config.root, 'public', 'menu.html')));
  app.get('/admin', requireAdmin, (req, res) => res.sendFile(path.join(config.root, 'public', 'admin.html')));
  app.get('/pos', requireAuth({ redirect: true }), (req, res) => res.redirect('/erp#orders'));
  app.get('/kitchen', requireAuth({ redirect: true }), (req, res) => res.sendFile(path.join(config.root, 'public', 'kds.html')));
  app.get('/bar', requireAuth({ redirect: true }), (req, res) => res.sendFile(path.join(config.root, 'public', 'kds.html')));
  app.get('/reports', requireAuth({ redirect: true }), (req, res) => res.sendFile(path.join(config.root, 'public', 'reports.html')));
  app.get('/billing', requireAuth({ redirect: true }), (req, res) => res.redirect('/erp#billing'));
  app.get('/cashier-handoff', requireAuth({ redirect: true }), (req, res) => res.redirect('/erp#handoff'));
  app.get('/printers', requireAuth({ redirect: true }), (req, res) => res.redirect('/erp#printers'));
  app.get('/login', (req, res) => res.sendFile(path.join(config.root, 'public', 'login.html')));
  app.get('/license/activate', (req, res) => res.sendFile(path.join(config.root, 'public', 'license.html')));
  app.get('/erp', requireAuth({ redirect: true }), (req, res) => res.sendFile(path.join(config.root, 'public', 'erp.html')));
  app.get('/erp/*', requireAuth({ redirect: true }), (req, res) => res.sendFile(path.join(config.root, 'public', 'erp.html')));
  app.get('/', (req, res) => res.redirect('/menu'));

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: { message: 'Not found' } });
    return res.status(404).send('Not found');
  });

  app.use((error, req, res, next) => {
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    res.status(status).json({ error: { message: error.message || 'Unexpected error' } });
  });

  return app;
}

async function main() {
  const db = await initDb();
  await seedDemoData(db);
  await seedErpData(db);
  const app = createCloudApp(db);
  app.listen(config.port, '0.0.0.0', () => {
    console.log(`Restaurant cloud app listening on http://localhost:${config.port}`);
    console.log(`Public menu: http://localhost:${config.port}/menu`);
    console.log(`Admin:       http://localhost:${config.port}/admin`);
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { createCloudApp, main, upsertOrder, applyOutbox };
