const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const QRCode = require('qrcode');
const config = require('./config');
const { getDb, initDb, nowIso, setSetting } = require('./db');
const { seedDemoData } = require('./seed');
const { seedErpData } = require('./seed-erp');
const { buildTicketText, widthFor } = require('./escpos');
const { processPrintQueue, testPrint } = require('./printer');
const { startSyncLoop, runSync, syncStatus } = require('./sync');
const { createReportService } = require('./reports/reportService');
const { createReportsRouter } = require('./reports/routes');
const { createAuthRouter, createErpRouter } = require('./erp');
const { authMiddleware, requireAuth } = require('./auth');
const inventory = require('./inventory');
const { rateLimit } = require('./rateLimit');

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const money = (value) => Math.round(Number(value || 0) * 100) / 100;

async function getSettingsRow(db) {
  return db.get('SELECT * FROM settings WHERE id = 1');
}

function settingsForTicket(row) {
  return {
    restaurantName: row.restaurant_name,
    currency: row.currency,
    taxRate: Number(row.tax_rate),
    receiptFooter: row.receipt_footer,
    paperWidth: config.printer.paperWidth,
  };
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
  };
}

function mapOrder(row) {
  return {
    id: row.id,
    uuid: row.sync_id,
    orderNumber: row.order_number,
    type: row.type,
    source: row.source,
    status: row.status,
    tableId: row.table_id,
    tableNumber: row.table_number || null,
    guestCount: row.guest_count,
    subtotal: Number(row.subtotal),
    discountTotal: Number(row.discount_total),
    taxTotal: Number(row.tax_total),
    serviceTotal: Number(row.service_total),
    total: Number(row.total),
    paidTotal: Number(row.paid_total),
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    syncedAt: row.synced_at,
  };
}

function mapItemRow(row) {
  return {
    id: row.id,
    uuid: row.sync_id,
    orderId: row.order_id,
    menuItemId: row.menu_item_id,
    menuItemUuid: row.menu_item_sync_id,
    name: row.name,
    quantity: row.quantity,
    unitPrice: Number(row.unit_price),
    lineTotal: Number(row.line_total),
    notes: row.notes,
    station: row.station,
    status: row.status,
    createdAt: row.created_at,
  };
}

function mapPayment(row) {
  return {
    id: row.id,
    uuid: row.sync_id,
    receiptNumber: row.receipt_number,
    methodCode: row.method_code,
    amount: Number(row.amount),
    tendered: row.tendered == null ? null : Number(row.tendered),
    changeDue: row.change_due == null ? null : Number(row.change_due),
    reference: row.reference,
    createdAt: row.created_at,
  };
}

async function listOrders(db, options = {}) {
  const limit = Math.min(Number(options.limit || 50), 200);
  const where = options.openOnly
    ? "WHERE o.deleted = 0 AND o.status NOT IN ('COMPLETED','CANCELLED','VOID')"
    : 'WHERE o.deleted = 0';
  const rows = await db.all(
    `SELECT o.*, t.number AS table_number
     FROM orders o LEFT JOIN dining_tables t ON t.id = o.table_id
     ${where}
     ORDER BY o.id DESC LIMIT ?`,
    [limit],
  );
  const orders = [];
  for (const row of rows) {
    const items = await db.all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC', [row.id]);
    const payments = await db.all('SELECT * FROM payments WHERE order_id = ? ORDER BY id ASC', [row.id]);
    orders.push({ ...mapOrder(row), items: items.map(mapItemRow), payments: payments.map(mapPayment) });
  }
  return orders;
}

async function getOrder(db, syncId) {
  const row = await db.get(
    `SELECT o.*, t.number AS table_number
     FROM orders o LEFT JOIN dining_tables t ON t.id = o.table_id
     WHERE o.sync_id = ?`,
    [syncId],
  );
  if (!row) return null;
  const items = await db.all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC', [row.id]);
  const payments = await db.all('SELECT * FROM payments WHERE order_id = ? ORDER BY id ASC', [row.id]);
  return { ...mapOrder(row), items: items.map(mapItemRow), payments: payments.map(mapPayment) };
}

async function nextOrderNumber(db) {
  const row = await db.get("SELECT value FROM sync_state WHERE key = 'order_counter'");
  const next = (row ? Number(row.value) : 0) + 1;
  await setSetting('order_counter', next);
  return `#${String(next).padStart(3, '0')}`;
}

async function enqueuePrintJob(db, { order, items, settings, documentType, station }) {
  const text = buildTicketText({
    type: documentType,
    order,
    items,
    settings,
    station,
  });
  const jobNumber = `JOB-${Date.now()}-${station || documentType}-${crypto.randomBytes(2).toString('hex')}`;
  await db.run(
    `INSERT INTO print_jobs
       (job_number, order_id, order_sync_id, document_type, station, payload, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?)`,
    [jobNumber, order.id || null, order.syncId || order.uuid || null, documentType, station || null, text, nowIso(), nowIso()],
  );
  return jobNumber;
}

async function enqueueOutbox(db, entity, entitySyncId, op, payload) {
  await db.run(
    `INSERT INTO sync_outbox (entity, entity_sync_id, op, payload, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [entity, entitySyncId, op, JSON.stringify(payload), nowIso()],
  );
}

async function createOrder(db, body) {
  const settings = await getSettingsRow(db);
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) {
    const error = new Error('Add at least one item to the order.');
    error.status = 400;
    throw error;
  }

  const tableId = body.tableId ? Number(body.tableId) : null;
  const table = tableId
    ? await db.get('SELECT * FROM dining_tables WHERE id = ?', [tableId])
    : null;

  const resolved = [];
  for (const line of items) {
    const menuItem = await db.get('SELECT * FROM menu_items WHERE id = ? AND deleted = 0', [Number(line.menuItemId)]);
    if (!menuItem) {
      const error = new Error(`Menu item ${line.menuItemId} was not found.`);
      error.status = 400;
      throw error;
    }
    if (!menuItem.available || menuItem.sold_out) {
      const error = new Error(`${menuItem.name} is sold out.`);
      error.status = 409;
      throw error;
    }
    const quantity = Math.max(1, Number(line.quantity || 1));
    const lineTotal = money(Number(menuItem.price) * quantity);
    resolved.push({
      menuItem,
      quantity,
      lineTotal,
      notes: line.notes || '',
      station: line.station || menuItem.station || 'Kitchen',
    });
  }

  const subtotal = money(resolved.reduce((sum, line) => sum + line.lineTotal, 0));
  const taxTotal = settings.tax_enabled ? money(subtotal * Number(settings.tax_rate) / 100) : 0;
  const serviceTotal = settings.service_charge_enabled
    ? money(subtotal * Number(settings.service_charge_rate) / 100)
    : 0;
  const total = money(subtotal + taxTotal + serviceTotal);
  const orderSyncId = crypto.randomUUID();
  const orderNumber = await nextOrderNumber(db);
  const createdAt = nowIso();
  const type = body.type || 'DINE_IN';

  let orderId;
  await db.tx(async (tx) => {
    const inserted = await tx.get(
      `INSERT INTO orders
         (sync_id, order_number, type, source, status, table_id, table_sync_id, guest_count,
          subtotal, discount_total, tax_total, service_total, total, paid_total, notes,
          idempotency_key, device_id, created_at, updated_at, synced_at, deleted)
       VALUES (?, ?, ?, 'STAFF', 'SUBMITTED', ?, ?, ?, ?, 0, ?, ?, ?, 0, ?, ?, ?, ?, ?, NULL, 0)
       RETURNING id`,
      [
        orderSyncId,
        orderNumber,
        type,
        table ? table.id : null,
        table ? table.sync_id : null,
        Number(body.guestCount || 1),
        subtotal,
        taxTotal,
        serviceTotal,
        total,
        body.notes || '',
        body.idempotencyKey || null,
        config.deviceId,
        createdAt,
        createdAt,
      ],
    );
    orderId = inserted.id;

    for (const line of resolved) {
      await tx.run(
        `INSERT INTO order_items
           (sync_id, order_id, order_sync_id, menu_item_id, menu_item_sync_id, name, quantity,
            unit_price, line_total, notes, station, status, created_at, synced_at, deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, NULL, 0)`,
        [
          crypto.randomUUID(),
          orderId,
          orderSyncId,
          line.menuItem.id,
          line.menuItem.sync_id,
          line.menuItem.name,
          line.quantity,
          Number(line.menuItem.price),
          line.lineTotal,
          line.notes,
          line.station,
          createdAt,
        ],
      );
    }

    const ticketOrder = {
      id: orderId,
      syncId: orderSyncId,
      orderNumber,
      type,
      tableNumber: table ? table.number : null,
      guestCount: Number(body.guestCount || 1),
      createdAt,
      deviceId: config.deviceId,
      subtotal,
      discountTotal: 0,
      taxTotal,
      serviceTotal,
      total,
      notes: body.notes || '',
    };

    const byStation = new Map();
    for (const line of resolved) {
      const station = line.station || 'Kitchen';
      if (!byStation.has(station)) byStation.set(station, []);
      byStation.get(station).push({
        quantity: line.quantity,
        name: line.menuItem.name,
        lineTotal: line.lineTotal,
        notes: line.notes,
      });
    }
    for (const [station, stationItems] of byStation) {
      await enqueuePrintJob(tx, {
        order: ticketOrder,
        items: stationItems,
        settings: settingsForTicket(settings),
        documentType: 'KITCHEN_TICKET',
        station,
      });
    }
  });

  if (Number(settings.deduct_stock_on_submit) !== 0) {
    await inventory.deductOrderInventory(db, orderSyncId, null);
  }

  return getOrder(db, orderSyncId);
}

async function payOrder(db, syncId, body) {
  const order = await db.get('SELECT * FROM orders WHERE sync_id = ? AND deleted = 0', [syncId]);
  if (!order) {
    const error = new Error('Order not found.');
    error.status = 404;
    throw error;
  }
  const settings = await getSettingsRow(db);
  const amount = money(body.amount == null ? Number(order.total) - Number(order.paid_total) : body.amount);
  if (amount <= 0) {
    const error = new Error('Payment amount must be greater than zero.');
    error.status = 400;
    throw error;
  }
  const tendered = body.tendered == null ? amount : money(body.tendered);
  const changeDue = money(Math.max(0, tendered - amount));
  const paidTotal = money(Number(order.paid_total) + amount);
  const status = paidTotal + 0.001 >= Number(order.total) ? 'PAID' : 'PARTIALLY_PAID';
  const createdAt = nowIso();
  const paymentSyncId = crypto.randomUUID();
  const receiptNumber = `RCP-${Date.now().toString().slice(-8)}`;

  await db.tx(async (tx) => {
    await tx.run(
      `INSERT INTO payments
         (sync_id, order_id, order_sync_id, receipt_number, method_code, amount, tendered,
          change_due, reference, created_at, synced_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)`,
      [
        paymentSyncId,
        order.id,
        order.sync_id,
        receiptNumber,
        body.methodCode || 'CASH',
        amount,
        tendered,
        changeDue,
        body.reference || null,
        createdAt,
      ],
    );
    await tx.run(
      'UPDATE orders SET paid_total = ?, status = ?, updated_at = ?, closed_at = COALESCE(?, closed_at) WHERE id = ?',
      [paidTotal, status, createdAt, status === 'PAID' ? createdAt : null, order.id],
    );

    const items = await tx.all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC', [order.id]);
    const table = order.table_id
      ? await tx.get('SELECT * FROM dining_tables WHERE id = ?', [order.table_id])
      : null;
    await enqueuePrintJob(tx, {
      order: {
        id: order.id,
        syncId: order.sync_id,
        orderNumber: order.order_number,
        type: order.type,
        tableNumber: table ? table.number : null,
        guestCount: order.guest_count,
        createdAt: order.created_at,
        deviceId: config.deviceId,
        subtotal: Number(order.subtotal),
        discountTotal: Number(order.discount_total),
        taxTotal: Number(order.tax_total),
        serviceTotal: Number(order.service_total),
        total: Number(order.total),
        notes: order.notes,
      },
      items: items.map((item) => ({
        quantity: item.quantity,
        name: item.name,
        lineTotal: Number(item.line_total),
        notes: item.notes,
      })),
      settings: settingsForTicket(settings),
      documentType: 'RECEIPT',
      station: 'Cashier',
    });
  });

  const paidOrder = await getOrder(db, syncId);
  if (paidOrder && paidOrder.status === 'PAID') {
    await inventory.deductOrderInventory(db, syncId, null);
  }
  return getOrder(db, syncId);
}

async function updateOrderStatus(db, syncId, status) {
  const allowed = new Set(['SUBMITTED', 'PREPARING', 'READY', 'SERVED', 'COMPLETED', 'CANCELLED', 'VOID']);
  if (!allowed.has(status)) {
    const error = new Error('Unknown order status.');
    error.status = 400;
    throw error;
  }
  const order = await db.get('SELECT * FROM orders WHERE sync_id = ? AND deleted = 0', [syncId]);
  if (!order) {
    const error = new Error('Order not found.');
    error.status = 404;
    throw error;
  }
  await db.run('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?', [status, nowIso(), order.id]);
  if (status === 'CANCELLED' || status === 'VOID') {
    await inventory.restoreOrderInventory(db, order, null);
  }
  return getOrder(db, syncId);
}

async function updateItemStatus(db, itemSyncId, status) {
  const item = await db.get('SELECT * FROM order_items WHERE sync_id = ?', [itemSyncId]);
  if (!item) {
    const error = new Error('Order item not found.');
    error.status = 404;
    throw error;
  }
  await db.run('UPDATE order_items SET status = ? WHERE id = ?', [status, item.id]);

  const siblings = await db.all('SELECT status FROM order_items WHERE order_id = ?', [item.order_id]);
  const allReady = siblings.every((row) => row.status === 'READY' || row.status === 'SERVED');
  const allServed = siblings.every((row) => row.status === 'SERVED');
  const orderStatus = allServed ? 'COMPLETED' : allReady ? 'READY' : 'PREPARING';
  await db.run('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?', [orderStatus, nowIso(), item.order_id]);
  return { itemId: item.id, status, orderStatus };
}

async function listKitchen(db) {
  const orders = await listOrders(db, { openOnly: true, limit: 100 });
  return orders
    .map((order) => ({
      ...order,
      items: order.items.filter((item) => ['PENDING', 'PREPARING', 'READY'].includes(item.status)),
    }))
    .filter((order) => order.items.length > 0);
}

function buildLocalApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use('/assets', express.static(path.join(config.root, 'public', 'assets'), { maxAge: 0 }));
  const erpHtml = fs.readFileSync(path.join(config.root, 'public', 'index.html'), 'utf8');
  function serveErpApp(req, res) {
    let html = erpHtml.replace(
      '<script src="/assets/js/reports.js"></script>\n  <script src="/assets/js/premium-preview.js"></script>\n  <script src="/assets/js/node-live.js"></script>',
      '<link rel="stylesheet" href="/assets/css/erp.css">\n  <script src="/assets/js/erp.js"></script>'
    );
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  }
  app.get('/', serveErpApp);
  app.get('/erp', serveErpApp);
  app.get('/erp/*', serveErpApp);
  app.use(express.static(path.join(config.root, 'public'), { maxAge: 0 }));
  app.use(authMiddleware);
  app.use('/api/auth', createAuthRouter(db));
  app.use('/api/erp', createErpRouter(db));

  const reportService = createReportService({
    databaseUrl: db.kind === 'postgres' ? config.databaseUrl : '',
    currency: config.currency,
    timeZone: config.timeZone,
  });
  app.use('/api/reports', createReportsRouter(reportService, { timeZone: config.timeZone }));

  app.use('/api/public/menu', rateLimit({ windowMs: 60_000, max: 120 }));
  app.get('/api/health', asyncRoute(async (req, res) => {
    await db.get('SELECT 1 AS ok');
    res.json({ status: 'ok', mode: 'local', database: db.kind, time: nowIso() });
  }));

  app.get('/api/bootstrap', asyncRoute(async (req, res) => {
    const settings = await getSettingsRow(db);
    const categories = await db.all('SELECT * FROM menu_categories WHERE deleted = 0 ORDER BY sort, id');
    const items = await db.all(
      `SELECT i.*, c.name AS category_name
       FROM menu_items i LEFT JOIN menu_categories c ON c.id = i.category_id
       WHERE i.deleted = 0
       ORDER BY c.sort, i.sort_order, i.id`,
    );
    const tables = await db.all('SELECT * FROM dining_tables WHERE deleted = 0 ORDER BY number');
    const counts = await db.get(
      `SELECT
         (SELECT COUNT(*) FROM orders WHERE deleted = 0) AS orders,
         (SELECT COUNT(*) FROM orders WHERE deleted = 0 AND status NOT IN ('COMPLETED','CANCELLED')) AS open_orders,
         (SELECT COUNT(*) FROM print_jobs WHERE status = 'QUEUED') AS print_queue`,
    );
    res.json({
      settings: {
        restaurantName: settings.restaurant_name,
        currency: settings.currency,
        taxRate: Number(settings.tax_rate),
        serviceChargeRate: Number(settings.service_charge_rate),
        serviceChargeEnabled: Boolean(settings.service_charge_enabled),
        taxEnabled: Boolean(settings.tax_enabled),
        receiptFooter: settings.receipt_footer,
        restaurantCode: settings.restaurant_code,
      },
      categories: categories.map((row) => ({ id: row.id, uuid: row.sync_id, name: row.name, sort: row.sort })),
      items: items.map(mapItem),
      tables: tables.map((row) => ({
        id: row.id,
        uuid: row.sync_id,
        number: row.number,
        name: row.name,
        capacity: row.capacity,
        status: row.status,
        qrToken: row.qr_token,
      })),
      printer: {
        name: config.printer.name,
        ip: config.printer.ip,
        port: config.printer.port,
        dryRun: config.printer.dryRun,
        paperWidth: config.printer.paperWidth,
        width: widthFor(config.printer.paperWidth),
      },
      sync: await syncStatus(db, config),
      counts: {
        orders: Number(counts.orders),
        openOrders: Number(counts.open_orders),
        printQueue: Number(counts.print_queue),
      },
      publicUrl: config.publicUrl || `http://localhost:${config.port}`,
      deviceId: config.deviceId,
    });
  }));

  app.get('/api/menu', asyncRoute(async (req, res) => {
    const items = await db.all(
      `SELECT i.*, c.name AS category_name
       FROM menu_items i LEFT JOIN menu_categories c ON c.id = i.category_id
       WHERE i.deleted = 0 ORDER BY c.sort, i.sort_order, i.id`,
    );
    res.json({ items: items.map(mapItem) });
  }));

  app.get('/api/orders', asyncRoute(async (req, res) => {
    res.json({ orders: await listOrders(db, { openOnly: req.query.open === '1', limit: req.query.limit }) });
  }));

  app.post('/api/orders', asyncRoute(async (req, res) => {
    const order = await createOrder(db, req.body || {});
    res.status(201).json({ order });
  }));

  app.get('/api/orders/:syncId', asyncRoute(async (req, res) => {
    const order = await getOrder(db, req.params.syncId);
    if (!order) return res.status(404).json({ error: { message: 'Order not found.' } });
    res.json({ order });
  }));

  app.post('/api/orders/:syncId/status', asyncRoute(async (req, res) => {
    res.json({ order: await updateOrderStatus(db, req.params.syncId, req.body?.status) });
  }));

  app.post('/api/orders/:syncId/pay', asyncRoute(async (req, res) => {
    res.json({ order: await payOrder(db, req.params.syncId, req.body || {}) });
  }));

  app.get('/api/kitchen', asyncRoute(async (req, res) => {
    res.json({ orders: await listKitchen(db) });
  }));

  app.post('/api/kitchen/items/:syncId/status', asyncRoute(async (req, res) => {
    res.json(await updateItemStatus(db, req.params.syncId, req.body?.status || 'READY'));
  }));

  app.get('/api/admin/menu', asyncRoute(async (req, res) => {
    const categories = await db.all('SELECT * FROM menu_categories WHERE deleted = 0 ORDER BY sort, id');
    const items = await db.all(
      `SELECT i.*, c.name AS category_name
       FROM menu_items i LEFT JOIN menu_categories c ON c.id = i.category_id
       WHERE i.deleted = 0 ORDER BY c.sort, i.sort_order, i.id`,
    );
    res.json({
      categories: categories.map((row) => ({ id: row.id, uuid: row.sync_id, name: row.name, sort: row.sort })),
      items: items.map(mapItem),
    });
  }));

  app.post('/api/admin/menu/items', asyncRoute(async (req, res) => {
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
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
         RETURNING *`,
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

    await enqueueOutbox(db, 'menu_item', item.sync_id, 'upsert', {
      syncId: item.sync_id,
      categorySyncId: category.sync_id,
      name: item.name,
      description: item.description,
      price: Number(item.price),
      imageUrl: item.image_url,
      station: item.station,
      available: Boolean(item.available),
      soldOut: Boolean(item.sold_out),
      featured: Boolean(item.featured),
      sortOrder: item.sort_order,
      updatedAt: item.updated_at,
      deleted: false,
    });

    res.json({ item: mapItem({ ...item, category_name: category.name }) });
  }));

  app.delete('/api/admin/menu/items/:id', asyncRoute(async (req, res) => {
    const item = await db.get('SELECT * FROM menu_items WHERE id = ?', [Number(req.params.id)]);
    if (!item) return res.status(404).json({ error: { message: 'Menu item not found.' } });
    const now = nowIso();
    await db.run('UPDATE menu_items SET deleted = 1, updated_at = ? WHERE id = ?', [now, item.id]);
    await enqueueOutbox(db, 'menu_item', item.sync_id, 'delete', {
      syncId: item.sync_id,
      updatedAt: now,
      deleted: true,
    });
    res.json({ ok: true });
  }));

  app.post('/api/admin/menu/categories', asyncRoute(async (req, res) => {
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
    await enqueueOutbox(db, 'menu_category', category.sync_id, 'upsert', {
      syncId: category.sync_id,
      name: category.name,
      sort: Number(category.sort),
      active: true,
      updatedAt: category.updated_at,
      deleted: false,
    });
    res.json({ category: { id: category.id, uuid: category.sync_id, name: category.name, sort: category.sort } });
  }));

  app.get('/api/settings', asyncRoute(async (req, res) => {
    const settings = await getSettingsRow(db);
    res.json({
      settings: {
        restaurantName: settings.restaurant_name,
        currency: settings.currency,
        taxRate: Number(settings.tax_rate),
        serviceChargeRate: Number(settings.service_charge_rate),
        serviceChargeEnabled: Boolean(settings.service_charge_enabled),
        taxEnabled: Boolean(settings.tax_enabled),
        receiptFooter: settings.receipt_footer,
        restaurantCode: settings.restaurant_code,
      },
    });
  }));

  app.post('/api/settings', asyncRoute(async (req, res) => {
    const body = req.body || {};
    const settings = await getSettingsRow(db);
    const now = nowIso();
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
        now,
      ],
    );
    const updated = await getSettingsRow(db);
    await enqueueOutbox(db, 'settings', 'settings', 'upsert', {
      restaurantName: updated.restaurant_name,
      currency: updated.currency,
      taxRate: Number(updated.tax_rate),
      serviceChargeRate: Number(updated.service_charge_rate),
      serviceChargeEnabled: Boolean(updated.service_charge_enabled),
      taxEnabled: Boolean(updated.tax_enabled),
      receiptFooter: updated.receipt_footer,
      updatedAt: updated.updated_at,
    });
    res.json({ ok: true });
  }));

  app.get('/api/stats', asyncRoute(async (req, res) => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const row = await db.get(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(total), 0) AS sales,
              COALESCE(AVG(total), 0) AS average
       FROM orders WHERE deleted = 0 AND created_at >= ?`,
      [start.toISOString()],
    );
    const open = await db.get(
      "SELECT COUNT(*) AS open_orders FROM orders WHERE deleted = 0 AND status NOT IN ('COMPLETED','CANCELLED')",
    );
    res.json({
      today: {
        orders: Number(row.orders),
        sales: money(row.sales),
        average: money(row.average),
        openOrders: Number(open.open_orders),
      },
    });
  }));

  app.post('/api/print/test', asyncRoute(async (req, res) => {
    const jobNumber = await testPrint(db, config);
    res.json({ ok: true, jobNumber, dryRun: config.printer.dryRun });
  }));

  app.post('/api/print/process', asyncRoute(async (req, res) => {
    await processPrintQueue(db, config);
    res.json({ ok: true });
  }));

  app.get('/api/print/jobs', asyncRoute(async (req, res) => {
    const rows = await db.all('SELECT * FROM print_jobs ORDER BY id DESC LIMIT 30');
    res.json({ jobs: rows });
  }));

  app.get('/api/sync/status', asyncRoute(async (req, res) => {
    res.json(await syncStatus(db, config));
  }));

  app.post('/api/sync/run', asyncRoute(async (req, res) => {
    res.json(await runSync(db, config));
  }));

  const qrHandler = asyncRoute(async (req, res) => {
    const settings = await getSettingsRow(db);
    const code = settings.restaurant_code || config.deviceId;
    const text = String(req.query.text || `${config.publicUrl || `http://localhost:${config.port}`}/menu/${code}`);
    const buffer = await QRCode.toBuffer(text, { width: 512, margin: 1, color: { dark: '#1f2a20', light: '#ffffff' } });
    res.type('png').send(buffer);
  });
  app.get('/api/qr', qrHandler);
  app.get('/api/admin/qr', qrHandler);

  app.get('/api/public/menu', asyncRoute(async (req, res) => {
    const settings = await getSettingsRow(db);
    const token = req.query.t ? String(req.query.t) : null;
    const table = token ? await db.get('SELECT * FROM dining_tables WHERE qr_token = ? AND deleted = 0', [token]) : null;
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
        restaurantCode: settings.restaurant_code,
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

  app.get('/menu', (req, res) => res.sendFile(path.join(config.root, 'public', 'menu.html')));
  app.get('/menu/:code', (req, res) => res.sendFile(path.join(config.root, 'public', 'menu.html')));

  app.get('/admin', (req, res) => res.sendFile(path.join(config.root, 'public', 'index.html')));

  app.get('/pos', (req, res) => res.sendFile(path.join(config.root, 'public', 'index.html')));
  app.get('/kitchen', requireAuth({ redirect: true }), (req, res) => res.sendFile(path.join(config.root, 'public', 'kds.html')));
  app.get('/bar', requireAuth({ redirect: true }), (req, res) => res.sendFile(path.join(config.root, 'public', 'kds.html')));
  app.get('/reports', requireAuth({ redirect: true }), (req, res) => res.sendFile(path.join(config.root, 'public', 'reports.html')));
  app.get('/billing', requireAuth({ redirect: true }), (req, res) => res.redirect('/erp#billing'));
  app.get('/cashier-handoff', requireAuth({ redirect: true }), (req, res) => res.redirect('/erp#handoff'));
  app.get('/printers', requireAuth({ redirect: true }), (req, res) => res.redirect('/erp#printers'));

  app.get('/login', (req, res) => res.sendFile(path.join(config.root, 'public', 'login.html')));
  app.get('/license/activate', (req, res) => res.sendFile(path.join(config.root, 'public', 'license.html')));

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: { message: 'Not found' } });
    serveErpApp(req, res);
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
  const app = buildLocalApp(db);
  const sync = startSyncLoop(db, config);

  setInterval(() => {
    processPrintQueue(db, config).catch((error) => console.error('[print]', error.message));
  }, 3_000).unref();

  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log('');
    console.log(`  Restaurant Node app (local)  http://localhost:${config.port}`);
    console.log(`  Database                     ${db.kind}`);
    console.log(`  Printer                      ${config.printer.dryRun ? 'DRY RUN -> logs/' : `${config.printer.ip}:${config.printer.port}`}`);
    console.log(`  Sync                         every ${Math.round(sync.interval / 1000)}s -> ${config.cloudUrl || 'not configured'}`);
    console.log(`  Public menu                  http://localhost:${config.port}/menu`);
    console.log('');
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.log('');
      console.log(`  Already running at http://localhost:${config.port}`);
      console.log('  Open that URL instead of starting another copy.');
      console.log('');
      process.exit(0);
    }
    throw error;
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { buildLocalApp, main };
