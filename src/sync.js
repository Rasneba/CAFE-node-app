const { nowIso, getSetting, setSetting } = require('./db');

function request(url, options, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

function deviceHeaders(config) {
  return {
    'content-type': 'application/json',
    'x-device-id': config.deviceId,
    'x-device-key': config.deviceApiKey,
  };
}

async function collectPendingOrders(db) {
  const orders = await db.all(
    `SELECT * FROM orders WHERE deleted = 0 ORDER BY id ASC LIMIT 50`,
  );
  const payload = [];
  for (const order of orders) {
    const items = await db.all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC', [order.id]);
    const payments = await db.all('SELECT * FROM payments WHERE order_id = ? ORDER BY id ASC', [order.id]);
    payload.push({
      syncId: order.sync_id,
      orderNumber: order.order_number,
      type: order.type,
      source: order.source,
      status: order.status,
      tableSyncId: order.table_sync_id,
      guestCount: order.guest_count,
      subtotal: Number(order.subtotal),
      discountTotal: Number(order.discount_total),
      taxTotal: Number(order.tax_total),
      serviceTotal: Number(order.service_total),
      total: Number(order.total),
      paidTotal: Number(order.paid_total),
      notes: order.notes,
      idempotencyKey: order.idempotency_key,
      createdAt: order.created_at,
      updatedAt: order.updated_at,
      syncedAt: order.synced_at || null,
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
        syncedAt: item.synced_at || null,
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
        syncedAt: payment.synced_at || null,
      })),
    });
  }
  return payload;
}

async function collectSyncedOrderUpdates(db) {
  const orders = await db.all(
    `SELECT * FROM orders WHERE synced_at IS NOT NULL AND deleted = 0 AND updated_at > synced_at ORDER BY id ASC LIMIT 50`,
  );
  const payload = [];
  for (const order of orders) {
    const items = await db.all('SELECT * FROM order_items WHERE order_id = ? AND (synced_at IS NULL OR updated_at > synced_at) ORDER BY id ASC', [order.id]);
    const payments = await db.all('SELECT * FROM payments WHERE order_id = ? AND (synced_at IS NULL OR updated_at > synced_at) ORDER BY id ASC', [order.id]);
    payload.push({
      syncId: order.sync_id,
      orderNumber: order.order_number,
      status: order.status,
      paidTotal: Number(order.paid_total),
      updatedAt: order.updated_at,
      items: items.map((item) => ({
        syncId: item.sync_id,
        status: item.status,
      })),
      payments: payments.map((payment) => ({
        syncId: payment.sync_id,
        amount: Number(payment.amount),
        methodCode: payment.method_code,
        receiptNumber: payment.receipt_number,
      })),
    });
  }
  return payload;
}

async function collectOutbox(db) {
  const rows = await db.all(
    `SELECT * FROM sync_outbox WHERE synced_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
     ORDER BY id ASC LIMIT 100`,
    [nowIso()],
  );
  return rows.map((row) => {
    let payload = {};
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = {};
    }
    return { id: row.id, entity: row.entity, op: row.op, payload };
  });
}

async function push(db, config) {
  const orders = await collectPendingOrders(db);
  const orderUpdates = await collectSyncedOrderUpdates(db);
  const outbox = await collectOutbox(db);
  if (!orders.length && !orderUpdates.length && !outbox.length) return { pushed: 0, outbox: 0 };
  if (!config.cloudUrl || !config.deviceApiKey) {
    return { pushed: 0, outbox: 0, skipped: 'cloud-not-configured' };
  }

  const response = await request(`${config.cloudUrl}/api/sync/push`, {
    method: 'POST',
    headers: deviceHeaders(config),
    body: JSON.stringify({
      deviceId: config.deviceId,
      orders,
      orderUpdates,
      outbox: outbox.map(({ id, entity, op, payload }) => ({ id, entity, op, payload })),
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error?.message || `Cloud push failed (${response.status})`);
  }

  const accepted = new Set((body.accepted || orders.map((order) => order.syncId)));
  const acceptedUpdates = new Set(body.acceptedUpdates || orderUpdates.map((u) => u.syncId));
  const acceptedOutbox = new Set(body.acceptedOutbox || outbox.map((row) => row.id));
  const stamp = nowIso();
  await db.tx(async (tx) => {
    for (const order of orders) {
      if (!accepted.has(order.syncId)) continue;
      await tx.run('UPDATE orders SET synced_at = ? WHERE sync_id = ?', [stamp, order.syncId]);
      await tx.run('UPDATE order_items SET synced_at = ? WHERE order_sync_id = ?', [stamp, order.syncId]);
      await tx.run('UPDATE payments SET synced_at = ? WHERE order_sync_id = ?', [stamp, order.syncId]);
    }
    for (const update of orderUpdates) {
      if (!acceptedUpdates.has(update.syncId)) continue;
      await tx.run('UPDATE orders SET synced_at = ? WHERE sync_id = ?', [stamp, update.syncId]);
      for (const item of update.items || []) {
        await tx.run('UPDATE order_items SET synced_at = ? WHERE sync_id = ?', [stamp, item.syncId]);
      }
      for (const payment of update.payments || []) {
        await tx.run('UPDATE payments SET synced_at = ? WHERE sync_id = ?', [stamp, payment.syncId]);
      }
    }
    for (const row of outbox) {
      if (!acceptedOutbox.has(row.id)) continue;
      await tx.run('UPDATE sync_outbox SET synced_at = ? WHERE id = ?', [stamp, row.id]);
    }
  });
  return { pushed: accepted.size + acceptedUpdates.size, outbox: acceptedOutbox.size };
}

async function recordSyncFailure(db, entityType, entitySyncId, errorMessage) {
  const stamp = nowIso();
  const attempts = 1;
  const delay = 15_000;
  const nextAttempt = new Date(Date.now() + delay).toISOString();
  if (entityType === 'outbox') {
    await db.run(
      `UPDATE sync_outbox SET attempts = attempts + 1, next_attempt_at = ?, last_error = ?, updated_at = ?
       WHERE entity_sync_id = ? AND synced_at IS NULL`,
      [nextAttempt, errorMessage, stamp, entitySyncId],
    );
  }
}

async function upsertMenu(db, data) {
  for (const category of data.categories || []) {
    await db.run(
      `INSERT INTO menu_categories (sync_id, name, name_am, sort, active, updated_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (sync_id) DO UPDATE SET
         name = excluded.name,
         name_am = excluded.name_am,
         sort = excluded.sort,
         active = excluded.active,
         updated_at = excluded.updated_at,
         deleted = excluded.deleted`,
      [
        category.syncId,
        category.name,
        category.nameAm || null,
        Number(category.sort || 0),
        category.active === false ? 0 : 1,
        category.updatedAt || nowIso(),
        category.deleted ? 1 : 0,
      ],
    );
  }

  for (const item of data.items || []) {
    await db.run(
      `INSERT INTO menu_items
         (sync_id, category_id, category_sync_id, name, name_am, description, price, image_url,
          station, available, sold_out, featured, sort_order, updated_at, deleted)
       VALUES (?, (SELECT id FROM menu_categories WHERE sync_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (sync_id) DO UPDATE SET
         category_id = excluded.category_id,
         category_sync_id = excluded.category_sync_id,
         name = excluded.name,
         name_am = excluded.name_am,
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
        item.syncId,
        item.categorySyncId || null,
        item.categorySyncId || null,
        item.name,
        item.nameAm || null,
        item.description || null,
        Number(item.price || 0),
        item.imageUrl || null,
        item.station || 'Kitchen',
        item.available === false ? 0 : 1,
        item.soldOut ? 1 : 0,
        item.featured ? 1 : 0,
        Number(item.sortOrder || 0),
        item.updatedAt || nowIso(),
        item.deleted ? 1 : 0,
      ],
    );
  }

  for (const table of data.tables || []) {
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
        table.syncId,
        table.number,
        table.name,
        Number(table.capacity || 4),
        table.status || 'AVAILABLE',
        table.qrToken || null,
        table.updatedAt || nowIso(),
        table.deleted ? 1 : 0,
      ],
    );
  }

  for (const order of data.orders || []) {
    if (!order.syncId) continue;
    const existing = await db.get('SELECT id FROM orders WHERE sync_id = ?', [order.syncId]);
    if (existing) continue;
    const orderId = crypto.randomUUID();
    await db.run(
      `INSERT INTO orders
         (sync_id, order_number, type, source, status, table_sync_id, guest_count, subtotal,
          discount_total, tax_total, service_total, total, paid_total, notes, idempotency_key,
          device_id, created_at, updated_at, synced_at, deleted)
       VALUES (?, ?, ?, 'ONLINE', ?, ?, ?, ?, 0, ?, ?, ?, 0, ?, ?, 'online-portal', ?, ?, ?, 0)`,
      [
        order.syncId,
        order.orderNumber,
        order.type || 'ONLINE',
        order.status || 'SUBMITTED',
        order.tableSyncId || null,
        Number(order.guestCount || 1),
        Number(order.subtotal || 0),
        Number(order.taxTotal || 0),
        Number(order.serviceTotal || 0),
        Number(order.total || 0),
        order.notes || null,
        order.idempotencyKey || null,
        order.createdAt || nowIso(),
        order.updatedAt || nowIso(),
      ],
    );
    for (const item of order.items || []) {
      await db.run(
        `INSERT INTO order_items
           (sync_id, order_id, order_sync_id, menu_item_id, menu_item_sync_id, name, quantity,
            unit_price, line_total, notes, station, status, created_at, synced_at, deleted)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, NULL, 0)`,
        [
          item.syncId,
          orderId,
          order.syncId,
          item.menuItemSyncId || null,
          item.name,
          Number(item.quantity || 1),
          Number(item.unitPrice || 0),
          Number(item.lineTotal || 0),
          item.notes || null,
          item.station || 'Kitchen',
          item.createdAt || order.createdAt || nowIso(),
        ],
      );
    }
    for (const payment of order.payments || []) {
      await db.run(
        `INSERT INTO payments
           (sync_id, order_id, order_sync_id, receipt_number, method_code, amount, tendered,
            change_due, reference, created_at, synced_at, deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)`,
        [
          payment.syncId,
          orderId,
          order.syncId,
          payment.receiptNumber || null,
          payment.methodCode || 'CASH',
          Number(payment.amount || 0),
          payment.tendered == null ? null : Number(payment.tendered),
          payment.changeDue == null ? null : Number(payment.changeDue),
          payment.reference || null,
          payment.createdAt || order.createdAt || nowIso(),
        ],
      );
    }
  }

  if (data.settings) {
    const s = data.settings;
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
        s.restaurantName ?? null,
        s.currency ?? null,
        s.taxRate ?? null,
        s.serviceChargeRate ?? null,
        s.serviceChargeEnabled == null ? null : (s.serviceChargeEnabled ? 1 : 0),
        s.taxEnabled == null ? null : (s.taxEnabled ? 1 : 0),
        s.receiptFooter ?? null,
        s.updatedAt || nowIso(),
      ],
    );
  }
}

async function pull(db, config) {
  if (!config.cloudUrl || !config.deviceApiKey) {
    return { pulled: false, skipped: 'cloud-not-configured' };
  }
  const since = await getSetting('last_pull_at', '1970-01-01T00:00:00.000Z');
  const response = await request(`${config.cloudUrl}/api/sync/pull?since=${encodeURIComponent(since)}`, {
    headers: deviceHeaders(config),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error?.message || `Cloud pull failed (${response.status})`);
  }

  await db.tx(async (tx) => {
    await upsertMenu(tx, body);
  });
  await setSetting('last_pull_at', body.serverTime || nowIso());
  return {
    pulled: true,
    categories: (body.categories || []).length,
    items: (body.items || []).length,
    tables: (body.tables || []).length,
  };
}

async function runSync(db, config, logger = console) {
  const startedAt = nowIso();
  const result = { startedAt, push: null, pull: null, error: null };

  if (!config.cloudUrl || !config.deviceApiKey) {
    result.error = 'Cloud sync is not configured (CLOUD_URL / DEVICE_API_KEY).';
    await setSetting('last_sync_at', startedAt);
    await setSetting('last_sync_result', 'offline-only');
    await setSetting('last_sync_error', result.error);
    return result;
  }

  try {
    result.push = await push(db, config);
  } catch (error) {
    result.error = error.message;
    logger.error(`[sync] push failed: ${error.message}`);
  }

  try {
    result.pull = await pull(db, config);
  } catch (error) {
    result.error = result.error || error.message;
    logger.error(`[sync] pull failed: ${error.message}`);
  }

  const finishedAt = nowIso();
  const success = !result.error;
  await setSetting('last_sync_at', finishedAt);
  await setSetting('last_sync_result', result.error ? 'error' : 'ok');
  await setSetting('last_sync_error', result.error || '');
  if (success) {
    await setSetting('last_successful_sync_at', finishedAt);
  }
  await setSetting('last_sync_counts', JSON.stringify({
    pushed: result.push?.pushed || 0,
    outbox: result.push?.outbox || 0,
    categories: result.pull?.categories || 0,
    items: result.pull?.items || 0,
    tables: result.pull?.tables || 0,
  }));
  logger.log(`[sync] ${result.error ? 'completed with errors' : 'ok'} in ${Date.now() - new Date(startedAt).getTime()}ms`);
  return result;
}

function startSyncLoop(db, config, logger = console) {
  const interval = Math.max(30_000, Number(config.syncIntervalMs) || 180_000);
  const runNow = () => runSync(db, config, logger);
  const timer = setInterval(() => {
    runNow().catch((error) => logger.error(`[sync] ${error.message}`));
  }, interval);
  timer.unref();
  setTimeout(() => {
    runNow().catch((error) => logger.error(`[sync] ${error.message}`));
  }, 5_000).unref();
  return { timer, interval, runNow };
}

async function syncStatus(db, config) {
  let lastCounts = {};
  try {
    lastCounts = JSON.parse(await getSetting('last_sync_counts', '{}'));
  } catch {
    lastCounts = {};
  }
  return {
    configured: Boolean(config.cloudUrl && config.deviceApiKey),
    cloudUrl: config.cloudUrl || null,
    deviceId: config.deviceId,
    intervalMs: config.syncIntervalMs,
    lastSyncAt: await getSetting('last_sync_at', null),
    lastSuccessfulSyncAt: await getSetting('last_successful_sync_at', null),
    lastPullAt: await getSetting('last_pull_at', null),
    lastResult: await getSetting('last_sync_result', 'never'),
    lastError: await getSetting('last_sync_error', ''),
    lastCounts,
  };
}

module.exports = { runSync, startSyncLoop, syncStatus, push, pull, upsertMenu };
