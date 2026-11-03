const crypto = require('node:crypto');
const express = require('express');
const config = require('./config');
const { getDb, nowIso } = require('./db');
const auth = require('./auth');
const inventory = require('./inventory');
const license = require('./license');

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const money = (value) => Math.round(Number(value || 0) * 100) / 100;

function asInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function asBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function clean(value) {
  return value == null ? null : String(value).trim();
}

function bad(res, message, status = 400) {
  return res.status(status).json({ error: { message } });
}

async function enqueueOutbox(db, entity, entitySyncId, op, payload) {
  await db.run(
    `INSERT INTO sync_outbox (entity, entity_sync_id, op, payload, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [entity, entitySyncId, op, JSON.stringify(payload), nowIso()],
  );
}

async function nextCounter(db, key) {
  const row = await db.get('SELECT value FROM document_counters WHERE key = ?', [key]);
  const next = (row ? Number(row.value) : 0) + 1;
  await db.run(
    `INSERT INTO document_counters (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, next, nowIso()],
  );
  return next;
}

function can(req, permission) {
  return Boolean(req.isSuperAdmin || req.permissions.includes('*') || req.permissions.includes(permission));
}

function guard(permission) {
  return (req, res, next) => {
    if (!req.user) return bad(res, 'Authentication required.', 401);
    if (can(req, permission)) return next();
    return bad(res, 'Insufficient permissions.', 403);
  };
}

function createAuthRouter(database) {
  const db = database || getDb();
  const router = express.Router();

  router.post('/login', asyncRoute(async (req, res) => {
    const email = clean(req.body?.email || req.body?.username);
    const password = req.body?.password;
    if (!email || !password) return bad(res, 'Email and password are required.');
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const userAgent = req.headers['user-agent'] || '';
    const locked = await auth.isAccountLocked(db, email);
    if (locked) {
      await auth.recordFailedLogin(db, { email, ip, userAgent, reason: 'account_locked' });
      return bad(res, 'Account is temporarily locked due to multiple failed login attempts. Please try again later.', 423);
    }
    const user = await db.get('SELECT * FROM users WHERE LOWER(email) = LOWER(?) AND deleted = 0', [email]);
    if (!user || !auth.verifyPassword(password, user.password_hash)) {
      await auth.recordFailedLogin(db, { email, ip, userAgent, reason: user ? 'invalid_password' : 'user_not_found' });
      return bad(res, 'Invalid credentials.', 401);
    }
    if (!user.active) {
      await auth.recordFailedLogin(db, { email, ip, userAgent, reason: 'account_inactive' });
      return bad(res, 'Account is deactivated. Please contact an administrator.', 403);
    }
    await db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [nowIso(), user.id]);
    const permissions = await auth.userPermissions(db, user.id);
    const token = auth.makeToken(user, permissions);
    await auth.createSession(db, { userId: user.id, token, ip, userAgent, ttlMs: config.sessionTtlMs });
    auth.setSessionCookie(res, token);
    await auth.recordLogin(db, { userId: user.id, email: user.email, ip, userAgent, success: true });
    await auth.audit(db, user, 'auth.login', 'user', user.id, { email: user.email }, req);
    return res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, isSuperAdmin: Boolean(user.is_super_admin) },
      permissions,
    });
  }));

  router.post('/logout', asyncRoute(async (req, res) => {
    const token = auth.getToken(req);
    if (token) {
      await auth.revokeSession(db, token);
    }
    auth.clearSessionCookie(res);
    return res.json({ ok: true });
  }));

  router.get('/me', asyncRoute(async (req, res) => {
    const session = await auth.loadUser(db, req);
    if (!session) return bad(res, 'Authentication required.', 401);
    return res.json({
      user: {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
        phone: session.user.phone,
        isSuperAdmin: session.isSuperAdmin,
      },
      permissions: session.permissions,
      license: await license.status(db),
    });
  }));

  router.post('/change-password', asyncRoute(async (req, res) => {
    const session = await auth.loadUser(db, req);
    if (!session) return bad(res, 'Authentication required.', 401);
    const current = req.body?.currentPassword;
    const next = req.body?.newPassword;
    if (!next || String(next).length < 8) return bad(res, 'New password must be at least 8 characters.');
    const user = await db.get('SELECT * FROM users WHERE id = ?', [session.user.id]);
    if (!user || !auth.verifyPassword(current, user.password_hash)) return bad(res, 'Current password is incorrect.', 403);
    await db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [auth.hashPassword(next), nowIso(), user.id]);
    await auth.audit(db, user, 'auth.change_password', 'user', user.id, null, req);
    return res.json({ ok: true });
  }));

  router.get('/sessions', asyncRoute(async (req, res) => {
    const session = await auth.loadUser(db, req);
    if (!session) return bad(res, 'Authentication required.', 401);
    const sessions = await auth.getActiveSessions(db, session.user.id);
    return res.json({ sessions });
  }));

  router.delete('/sessions/:id', asyncRoute(async (req, res) => {
    const session = await auth.loadUser(db, req);
    if (!session) return bad(res, 'Authentication required.', 401);
    const id = Number(req.params.id);
    const sessions = await auth.getActiveSessions(db, session.user.id);
    const target = sessions.find((s) => s.id === id);
    if (!target) return bad(res, 'Session not found.', 404);
    await auth.revokeSession(db, target.tokenHash);
    await auth.audit(db, session.user, 'auth.revoke_session', 'session', id, null, req);
    return res.json({ ok: true });
  }));

  router.delete('/sessions', asyncRoute(async (req, res) => {
    const currentSession = await auth.loadUser(db, req);
    if (!currentSession) return bad(res, 'Authentication required.', 401);
    const token = auth.getToken(req);
    await auth.revokeAllUserSessions(db, currentSession.user.id);
    if (token) await auth.revokeSession(db, token);
    auth.clearSessionCookie(res);
    await auth.audit(db, currentSession.user, 'auth.revoke_all_sessions', 'user', currentSession.user.id, null, req);
    return res.json({ ok: true });
  }));

  router.get('/login-history', asyncRoute(async (req, res) => {
    const session = await auth.loadUser(db, req);
    if (!session) return bad(res, 'Authentication required.', 401);
    const canViewAll = session.isSuperAdmin || session.permissions.includes('*') || session.permissions.includes('audit.view');
    const userId = canViewAll ? (req.query.userId ? Number(req.query.userId) : null) : session.user.id;
    const limit = Math.min(Number(req.query.limit || 50), 200);
    const history = await auth.getLoginHistory(db, { userId, limit });
    return res.json({ history });
  }));

  router.post('/forgot-password', asyncRoute(async (req, res) => {
    const email = clean(req.body?.email);
    if (!email) return bad(res, 'Email is required.');
    const user = await db.get('SELECT * FROM users WHERE LOWER(email) = LOWER(?) AND deleted = 0', [email]);
    if (!user) return res.json({ ok: true, message: 'If the email exists, a reset link has been sent.' });
    const resetToken = auth.generateResetToken();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    await db.run(
      `INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [`password_reset_${user.id}`, JSON.stringify({ token: resetToken, expiresAt })],
    );
    await auth.audit(db, null, 'auth.forgot_password', 'user', user.id, { email }, req);
    return res.json({ ok: true, message: 'If the email exists, a reset link has been sent.', resetToken });
  }));

  router.post('/reset-password', asyncRoute(async (req, res) => {
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword || String(newPassword).length < 8) return bad(res, 'Reset token and new password (min 8 chars) are required.');
    const row = await db.get("SELECT value FROM sync_state WHERE key LIKE 'password_reset_%'", []);
    if (!row) return bad(res, 'Invalid or expired reset token.', 400);
    const data = JSON.parse(row.value);
    if (data.token !== token || new Date(data.expiresAt) < new Date()) return bad(res, 'Invalid or expired reset token.', 400);
    const userId = Number(row.key.replace('password_reset_', ''));
    const user = await db.get('SELECT * FROM users WHERE id = ? AND deleted = 0', [userId]);
    if (!user) return bad(res, 'User not found.', 404);
    await db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [auth.hashPassword(newPassword), nowIso(), userId]);
    await db.run("DELETE FROM sync_state WHERE key = ?", [row.key]);
    await auth.revokeAllUserSessions(db, userId);
    await auth.audit(db, user, 'auth.reset_password', 'user', userId, null, req);
    return res.json({ ok: true });
  }));

  return router;
}

function createErpRouter(database) {
  const db = database || getDb();
  const router = express.Router();

  router.get('/dashboard', guard('dashboard.view'), asyncRoute(async (req, res) => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const today = start.toISOString();
    const summary = await db.get(
      `SELECT
         (SELECT COUNT(*) FROM orders WHERE deleted = 0 AND created_at >= ?) AS orders_today,
         (SELECT COALESCE(SUM(total), 0) FROM orders WHERE deleted = 0 AND status = 'PAID' AND created_at >= ?) AS sales_today,
         (SELECT COUNT(*) FROM orders WHERE deleted = 0 AND status NOT IN ('COMPLETED','CANCELLED','VOID')) AS open_orders,
         (SELECT COUNT(*) FROM ingredients WHERE deleted = 0 AND active = 1 AND current_stock <= min_stock) AS low_stock,
         (SELECT COUNT(*) FROM purchase_orders WHERE deleted = 0 AND status IN ('DRAFT','SENT','PARTIAL')) AS open_purchases,
         (SELECT COALESCE(SUM(amount), 0) FROM expenses WHERE deleted = 0 AND paid_at >= ?) AS expenses_today,
         (SELECT COUNT(*) FROM reservations WHERE deleted = 0 AND reserved_at >= ?) AS reservations_today`,
      [today, today, today, today],
    );
    const recentOrders = await db.all(
      `SELECT o.id, o.sync_id, o.order_number, o.status, o.type, o.total, o.created_at, t.number AS table_number
       FROM orders o LEFT JOIN dining_tables t ON t.id = o.table_id
       WHERE o.deleted = 0 ORDER BY o.id DESC LIMIT 8`,
    );
    const lowStock = await inventory.lowStockIngredients(db);
    const topItems = await db.all(
      `SELECT oi.name, SUM(oi.quantity) AS qty, SUM(oi.line_total) AS revenue
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE oi.deleted = 0 AND o.deleted = 0 AND o.created_at >= ?
       GROUP BY oi.name ORDER BY qty DESC LIMIT 5`,
      [today],
    );
    const reservations = await db.all(
      `SELECT r.id, r.guest_name, r.party_size, r.reserved_at, r.status, t.number AS table_number
       FROM reservations r LEFT JOIN dining_tables t ON t.id = r.table_id
       WHERE r.deleted = 0 AND r.reserved_at >= ? ORDER BY r.reserved_at LIMIT 5`,
      [today],
    );
    return res.json({
      summary: {
        ordersToday: Number(summary.orders_today),
        salesToday: money(summary.sales_today),
        openOrders: Number(summary.open_orders),
        lowStock: Number(summary.low_stock),
        openPurchases: Number(summary.open_purchases),
        expensesToday: money(summary.expenses_today),
        reservationsToday: Number(summary.reservations_today),
      },
      recentOrders: recentOrders.map((row) => ({
        id: row.id,
        uuid: row.sync_id,
        orderNumber: row.order_number,
        status: row.status,
        type: row.type,
        total: money(row.total),
        tableNumber: row.table_number,
        createdAt: row.created_at,
      })),
      lowStock: lowStock.slice(0, 8),
      topItems: topItems.map((row) => ({ name: row.name, quantity: Number(row.qty), revenue: money(row.revenue) })),
      reservations: reservations.map((row) => ({
        id: row.id,
        guestName: row.guest_name,
        partySize: row.party_size,
        reservedAt: row.reserved_at,
        status: row.status,
        tableNumber: row.table_number,
      })),
    });
  }));

  router.get('/license', asyncRoute(async (req, res) => {
    return res.json({ license: await license.status(db), machine: license.machineId() });
  }));

  router.post('/license/activate', guard('settings.manage'), asyncRoute(async (req, res) => {
    const key = clean(req.body?.key);
    if (!key) return bad(res, 'License key is required.');
    const result = await license.activateKey(db, key);
    await auth.audit(db, req.user, 'license.activate', 'license', null, { expiresAt: result.expiresAt }, req);
    return res.json(result);
  }));

  router.post('/license/issue', guard('settings.manage'), asyncRoute(async (req, res) => {
    const result = await license.issueLicense(db, {
      client: clean(req.body?.client),
      tin: clean(req.body?.tin),
      ttlDays: req.body?.ttlDays,
      expiresAt: req.body?.expiresAt,
    });
    await auth.audit(db, req.user, 'license.issue', 'license', null, { client: req.body?.client }, req);
    return res.json(result);
  }));

  router.get('/users', guard('staff.view'), asyncRoute(async (req, res) => {
    const users = await db.all(
      `SELECT id, sync_id, name, email, phone, active, is_super_admin, branch_id, last_login_at, created_at
       FROM users WHERE deleted = 0 ORDER BY name`,
    );
    const output = [];
    for (const user of users) {
      const roles = await db.all(
        `SELECT r.id, r.code, r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?`,
        [user.id],
      );
      output.push({
        id: user.id,
        uuid: user.sync_id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        active: Boolean(user.active),
        isSuperAdmin: Boolean(user.is_super_admin),
        branchId: user.branch_id,
        lastLoginAt: user.last_login_at,
        createdAt: user.created_at,
        roles,
      });
    }
    return res.json({ users: output });
  }));

  router.post('/users', guard('staff.manage'), asyncRoute(async (req, res) => {
    const name = clean(req.body?.name);
    const email = clean(req.body?.email);
    const password = req.body?.password;
    if (!name || !email || !password) return bad(res, 'Name, email and password are required.');
    if (String(password).length < 8) return bad(res, 'Password must be at least 8 characters.');
    const existing = await db.get('SELECT id FROM users WHERE LOWER(email) = LOWER(?)', [email]);
    if (existing) return bad(res, 'A user with that email already exists.', 409);
    const now = nowIso();
    const row = await db.get(
      `INSERT INTO users (sync_id, name, email, phone, password_hash, active, is_super_admin, branch_id, created_at, updated_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0) RETURNING id`,
      [
        crypto.randomUUID(), name, email, clean(req.body?.phone), auth.hashPassword(password),
        asBool(req.body?.active, true) ? 1 : 0, asBool(req.body?.isSuperAdmin) ? 1 : 0,
        req.body?.branchId ? asInt(req.body.branchId) : null, now, now,
      ],
    );
    const roleIds = Array.isArray(req.body?.roleIds) ? req.body.roleIds : [];
    for (const roleId of roleIds) {
      await db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', [row.id, asInt(roleId)]);
    }
    await auth.audit(db, req.user, 'user.create', 'user', row.id, { email }, req);
    return res.status(201).json({ user: { id: row.id, name, email } });
  }));

  router.post('/users/:id', guard('staff.manage'), asyncRoute(async (req, res) => {
    const id = asInt(req.params.id);
    const user = await db.get('SELECT * FROM users WHERE id = ? AND deleted = 0', [id]);
    if (!user) return bad(res, 'User not found.', 404);
    const now = nowIso();
    const password = req.body?.password;
    await db.run(
      `UPDATE users SET name = ?, email = ?, phone = ?, active = ?, is_super_admin = ?, branch_id = ?,
         password_hash = COALESCE(?, password_hash), updated_at = ? WHERE id = ?`,
      [
        clean(req.body?.name) || user.name,
        clean(req.body?.email) || user.email,
        req.body?.phone === undefined ? user.phone : clean(req.body.phone),
        req.body?.active === undefined ? user.active : (asBool(req.body.active, true) ? 1 : 0),
        req.body?.isSuperAdmin === undefined ? user.is_super_admin : (asBool(req.body.isSuperAdmin) ? 1 : 0),
        req.body?.branchId === undefined ? user.branch_id : (req.body.branchId ? asInt(req.body.branchId) : null),
        password ? auth.hashPassword(password) : null,
        now,
        id,
      ],
    );
    if (Array.isArray(req.body?.roleIds)) {
      await db.run('DELETE FROM user_roles WHERE user_id = ?', [id]);
      for (const roleId of req.body.roleIds) {
        await db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', [id, asInt(roleId)]);
      }
    }
    await auth.audit(db, req.user, 'user.update', 'user', id, null, req);
    return res.json({ ok: true });
  }));

  router.post('/users/:id/toggle', guard('staff.manage'), asyncRoute(async (req, res) => {
    const id = asInt(req.params.id);
    const user = await db.get('SELECT * FROM users WHERE id = ? AND deleted = 0', [id]);
    if (!user) return bad(res, 'User not found.', 404);
    const active = user.active ? 0 : 1;
    await db.run('UPDATE users SET active = ?, updated_at = ? WHERE id = ?', [active, nowIso(), id]);
    await auth.audit(db, req.user, active ? 'user.enable' : 'user.disable', 'user', id, null, req);
    return res.json({ ok: true, active: Boolean(active) });
  }));

  router.get('/roles', guard('staff.view'), asyncRoute(async (req, res) => {
    const roles = await db.all('SELECT * FROM roles ORDER BY code');
    const output = [];
    for (const role of roles) {
      const permissions = await db.all(
        'SELECT permission_code FROM role_permissions WHERE role_id = ? ORDER BY permission_code',
        [role.id],
      );
      output.push({
        id: role.id,
        code: role.code,
        name: role.name,
        description: role.description,
        isSystem: Boolean(role.is_system),
        permissions: permissions.map((row) => row.permission_code),
      });
    }
    return res.json({ roles: output });
  }));

  router.get('/permissions', guard('staff.view'), asyncRoute(async (req, res) => {
    const permissions = await db.all('SELECT * FROM permissions ORDER BY module, code');
    return res.json({ permissions });
  }));

  router.post('/roles', guard('staff.manage'), asyncRoute(async (req, res) => {
    const code = clean(req.body?.code);
    const name = clean(req.body?.name);
    if (!code || !name) return bad(res, 'Role code and name are required.');
    const existing = await db.get('SELECT id FROM roles WHERE code = ?', [code]);
    if (existing) return bad(res, 'A role with that code already exists.', 409);
    const row = await db.get(
      `INSERT INTO roles (code, name, description, is_system, created_at) VALUES (?, ?, ?, 0, ?) RETURNING id`,
      [code.toUpperCase(), name, clean(req.body?.description), nowIso()],
    );
    await auth.audit(db, req.user, 'role.create', 'role', row.id, { code }, req);
    return res.status(201).json({ role: { id: row.id, code: code.toUpperCase(), name } });
  }));

  router.post('/roles/:id/permissions', guard('staff.manage'), asyncRoute(async (req, res) => {
    const id = asInt(req.params.id);
    const role = await db.get('SELECT * FROM roles WHERE id = ?', [id]);
    if (!role) return bad(res, 'Role not found.', 404);
    const permissions = Array.isArray(req.body?.permissions) ? req.body.permissions : [];
    await db.run('DELETE FROM role_permissions WHERE role_id = ?', [id]);
    for (const permission of permissions) {
      await db.run('INSERT INTO role_permissions (role_id, permission_code) VALUES (?, ?)', [id, String(permission)]);
    }
    await auth.audit(db, req.user, 'role.permissions', 'role', id, { count: permissions.length }, req);
    return res.json({ ok: true });
  }));

  router.get('/customers', guard('customers.view'), asyncRoute(async (req, res) => {
    const limit = Math.min(asInt(req.query.limit, 100), 300);
    const q = clean(req.query.q);
    const params = [];
    let where = 'WHERE deleted = 0';
    if (q) {
      where += ' AND (LOWER(name) LIKE LOWER(?) OR phone LIKE ? OR LOWER(email) LIKE LOWER(?))';
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    const rows = await db.all(`SELECT * FROM customers ${where} ORDER BY name LIMIT ?`, [...params, limit]);
    return res.json({
      customers: rows.map((row) => ({
        id: row.id,
        uuid: row.sync_id,
        name: row.name,
        phone: row.phone,
        email: row.email,
        address: row.address,
        taxNumber: row.tax_number,
        loyaltyPoints: row.loyalty_points,
        visits: row.visits,
        totalSpent: money(row.total_spent),
        notes: row.notes,
        createdAt: row.created_at,
      })),
    });
  }));

  router.post('/customers', guard('customers.manage'), asyncRoute(async (req, res) => {
    const name = clean(req.body?.name);
    if (!name) return bad(res, 'Customer name is required.');
    const now = nowIso();
    const row = await db.get(
      `INSERT INTO customers (sync_id, name, phone, email, address, tax_number, loyalty_points, visits, total_spent, notes, created_at, updated_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, 0) RETURNING id`,
      [crypto.randomUUID(), name, clean(req.body?.phone), clean(req.body?.email), clean(req.body?.address), clean(req.body?.taxNumber), clean(req.body?.notes), now, now],
    );
    await auth.audit(db, req.user, 'customer.create', 'customer', row.id, { name }, req);
    return res.status(201).json({ customer: { id: row.id, name } });
  }));

  router.get('/customers/:id', guard('customers.view'), asyncRoute(async (req, res) => {
    const id = asInt(req.params.id);
    const customer = await db.get('SELECT * FROM customers WHERE id = ? AND deleted = 0', [id]);
    if (!customer) return bad(res, 'Customer not found.', 404);
    const stats = await db.get(
      `SELECT COUNT(*) AS visits, COALESCE(SUM(total), 0) AS spent FROM orders WHERE customer_id = ? AND deleted = 0`,
      [id],
    );
    const reservations = await db.all(
      'SELECT * FROM reservations WHERE customer_id = ? AND deleted = 0 ORDER BY reserved_at DESC LIMIT 20',
      [id],
    );
    return res.json({
      customer: {
        id: customer.id,
        uuid: customer.sync_id,
        name: customer.name,
        phone: customer.phone,
        email: customer.email,
        address: customer.address,
        taxNumber: customer.tax_number,
        loyaltyPoints: customer.loyalty_points,
        notes: customer.notes,
        visits: Number(stats.visits),
        totalSpent: money(stats.spent),
      },
      reservations,
    });
  }));

  router.post('/customers/:id', guard('customers.manage'), asyncRoute(async (req, res) => {
    const id = asInt(req.params.id);
    const customer = await db.get('SELECT * FROM customers WHERE id = ? AND deleted = 0', [id]);
    if (!customer) return bad(res, 'Customer not found.', 404);
    await db.run(
      `UPDATE customers SET name = ?, phone = ?, email = ?, address = ?, tax_number = ?, notes = ?, updated_at = ? WHERE id = ?`,
      [
        clean(req.body?.name) || customer.name,
        req.body?.phone === undefined ? customer.phone : clean(req.body.phone),
        req.body?.email === undefined ? customer.email : clean(req.body.email),
        req.body?.address === undefined ? customer.address : clean(req.body.address),
        req.body?.taxNumber === undefined ? customer.tax_number : clean(req.body.taxNumber),
        req.body?.notes === undefined ? customer.notes : clean(req.body.notes),
        nowIso(),
        id,
      ],
    );
    await auth.audit(db, req.user, 'customer.update', 'customer', id, null, req);
    return res.json({ ok: true });
  }));

  router.get('/reservations', guard('reservations.view'), asyncRoute(async (req, res) => {
    const date = clean(req.query.date);
    const status = clean(req.query.status);
    const q = clean(req.query.q);
    const params = [];
    let where = 'WHERE r.deleted = 0';
    if (date) {
      where += ' AND r.reserved_at >= ? AND r.reserved_at < ?';
      params.push(`${date}T00:00:00.000Z`, `${date}T23:59:59.999Z`);
    }
    if (status) {
      where += ' AND r.status = ?';
      params.push(status);
    }
    if (q) {
      where += ' AND (LOWER(r.guest_name) LIKE LOWER(?) OR r.phone LIKE ?)';
      params.push(`%${q}%`, `%${q}%`);
    }
    const rows = await db.all(
      `SELECT r.*, t.number AS table_number, c.name AS customer_name
       FROM reservations r
       LEFT JOIN dining_tables t ON t.id = r.table_id
       LEFT JOIN customers c ON c.id = r.customer_id
       ${where} ORDER BY r.reserved_at LIMIT 200`,
      params,
    );
    return res.json({
      reservations: rows.map((row) => ({
        id: row.id,
        uuid: row.sync_id,
        customerId: row.customer_id,
        customerName: row.customer_name,
        tableId: row.table_id,
        tableNumber: row.table_number,
        guestName: row.guest_name,
        phone: row.phone,
        partySize: row.party_size,
        reservedAt: row.reserved_at,
        durationMin: row.duration_min,
        status: row.status,
        notes: row.notes,
        createdAt: row.created_at,
      })),
    });
  }));

  router.post('/reservations', guard('reservations.manage'), asyncRoute(async (req, res) => {
    const guestName = clean(req.body?.guestName);
    const reservedAt = clean(req.body?.reservedAt);
    if (!guestName || !reservedAt) return bad(res, 'Guest name and reservation time are required.');
    const now = nowIso();
    const row = await db.get(
      `INSERT INTO reservations (sync_id, customer_id, table_id, guest_name, phone, party_size, reserved_at, duration_min, status, notes, created_by, created_at, updated_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'BOOKED', ?, ?, ?, ?, 0) RETURNING id`,
      [
        crypto.randomUUID(),
        req.body?.customerId ? asInt(req.body.customerId) : null,
        req.body?.tableId ? asInt(req.body.tableId) : null,
        guestName,
        clean(req.body?.phone),
        asInt(req.body?.partySize, 2),
        reservedAt,
        asInt(req.body?.durationMin, 90),
        clean(req.body?.notes),
        req.user.id || null,
        now,
        now,
      ],
    );
    await auth.audit(db, req.user, 'reservation.create', 'reservation', row.id, { guestName, reservedAt }, req);
    return res.status(201).json({ reservation: { id: row.id, guestName, reservedAt } });
  }));

  router.post('/reservations/:id/status', guard('reservations.manage'), asyncRoute(async (req, res) => {
    const id = asInt(req.params.id);
    const status = clean(req.body?.status);
    const allowed = ['BOOKED', 'SEATED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'];
    if (!allowed.includes(status)) return bad(res, 'Unknown reservation status.');
    const reservation = await db.get('SELECT * FROM reservations WHERE id = ? AND deleted = 0', [id]);
    if (!reservation) return bad(res, 'Reservation not found.', 404);
    await db.run('UPDATE reservations SET status = ?, updated_at = ? WHERE id = ?', [status, nowIso(), id]);
    await auth.audit(db, req.user, 'reservation.status', 'reservation', id, { status }, req);
    return res.json({ ok: true });
  }));

  router.get('/inventory', guard('inventory.view'), asyncRoute(async (req, res) => {
    const ingredients = await inventory.allIngredients(db);
    const movements = await inventory.stockMovements(db, { limit: 25 });
    const lowStock = ingredients.filter((item) => item.lowStock);
    return res.json({
      ingredients,
      lowStock,
      totals: {
        items: ingredients.length,
        lowStock: lowStock.length,
        stockValue: money(ingredients.reduce((sum, item) => sum + item.stockValue, 0)),
      },
      movements,
    });
  }));

  router.get('/inventory/movements', guard('inventory.view'), asyncRoute(async (req, res) => {
    return res.json({
      movements: await inventory.stockMovements(db, {
        ingredientId: req.query.ingredientId,
        movementType: clean(req.query.movementType),
        from: clean(req.query.from),
        to: clean(req.query.to),
        limit: req.query.limit,
      }),
    });
  }));

  router.post('/inventory/ingredients', guard('inventory.manage'), asyncRoute(async (req, res) => {
    const name = clean(req.body?.name);
    if (!name) return bad(res, 'Ingredient name is required.');
    const now = nowIso();
    const row = await db.get(
      `INSERT INTO ingredients (sync_id, name, sku, unit, current_stock, min_stock, cost_per_unit, supplier_id, active, created_at, updated_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0) RETURNING id`,
      [
        crypto.randomUUID(), name, clean(req.body?.sku), clean(req.body?.unit) || 'pcs',
        Number(req.body?.currentStock || 0), Number(req.body?.minStock || 0), Number(req.body?.costPerUnit || 0),
        req.body?.supplierId ? asInt(req.body.supplierId) : null, now, now,
      ],
    );
    await auth.audit(db, req.user, 'ingredient.create', 'ingredient', row.id, { name }, req);
    return res.status(201).json({ ingredient: { id: row.id, name } });
  }));

  router.post('/inventory/ingredients/:id', guard('inventory.manage'), asyncRoute(async (req, res) => {
    const id = asInt(req.params.id);
    const ingredient = await db.get('SELECT * FROM ingredients WHERE id = ? AND deleted = 0', [id]);
    if (!ingredient) return bad(res, 'Ingredient not found.', 404);
    await db.run(
      `UPDATE ingredients SET name = ?, sku = ?, unit = ?, min_stock = ?, cost_per_unit = ?, supplier_id = ?, active = ?, updated_at = ?
       WHERE id = ?`,
      [
        clean(req.body?.name) || ingredient.name,
        req.body?.sku === undefined ? ingredient.sku : clean(req.body.sku),
        req.body?.unit === undefined ? ingredient.unit : clean(req.body.unit),
        req.body?.minStock === undefined ? ingredient.min_stock : Number(req.body.minStock),
        req.body?.costPerUnit === undefined ? ingredient.cost_per_unit : Number(req.body.costPerUnit),
        req.body?.supplierId === undefined ? ingredient.supplier_id : (req.body.supplierId ? asInt(req.body.supplierId) : null),
        req.body?.active === undefined ? ingredient.active : (asBool(req.body.active, true) ? 1 : 0),
        nowIso(),
        id,
      ],
    );
    await auth.audit(db, req.user, 'ingredient.update', 'ingredient', id, null, req);
    return res.json({ ok: true });
  }));

  router.post('/inventory/adjust', guard('inventory.manage'), asyncRoute(async (req, res) => {
    const result = await inventory.adjustIngredientStock(db, {
      ingredientId: req.body?.ingredientId,
      quantity: req.body?.quantity,
      unitCost: req.body?.unitCost,
      referenceType: clean(req.body?.referenceType) || 'MANUAL',
      referenceId: clean(req.body?.referenceId),
      notes: clean(req.body?.notes),
      userId: req.user.id || null,
    });
    await auth.audit(db, req.user, 'inventory.adjust', 'ingredient', req.body?.ingredientId, { quantity: req.body?.quantity }, req);
    return res.json(result);
  }));

  router.get('/recipes', guard('inventory.view'), asyncRoute(async (req, res) => {
    const menuItemId = req.query.menuItemId ? asInt(req.query.menuItemId) : null;
    const params = [];
    let where = 'WHERE r.deleted = 0';
    if (menuItemId) {
      where += ' AND r.menu_item_id = ?';
      params.push(menuItemId);
    }
    const recipes = await db.all(
      `SELECT r.*, m.name AS menu_item_name, m.price AS menu_item_price
       FROM recipes r LEFT JOIN menu_items m ON m.id = r.menu_item_id
       ${where} ORDER BY m.name`,
      params,
    );
    const output = [];
    for (const recipe of recipes) {
      const lines = await inventory.getRecipeLines(db, recipe.id);
      output.push({
        id: recipe.id,
        uuid: recipe.sync_id,
        menuItemId: recipe.menu_item_id,
        menuItemName: recipe.menu_item_name,
        menuItemPrice: recipe.menu_item_price == null ? null : money(recipe.menu_item_price),
        name: recipe.name,
        yieldQty: Number(recipe.yield_qty),
        notes: recipe.notes,
        lines,
        cost: money(lines.reduce((sum, line) => sum + Number(line.quantity) * Number(line.costPerUnit || 0), 0)),
      });
    }
    return res.json({ recipes: output });
  }));

  router.post('/recipes', guard('inventory.manage'), asyncRoute(async (req, res) => {
    const menuItemId = asInt(req.body?.menuItemId);
    if (!menuItemId) return bad(res, 'Menu item is required.');
    const menuItem = await db.get('SELECT * FROM menu_items WHERE id = ? AND deleted = 0', [menuItemId]);
    if (!menuItem) return bad(res, 'Menu item not found.', 404);
    const now = nowIso();
    const name = clean(req.body?.name) || `Recipe for ${menuItem.name}`;
    const yieldQty = Number(req.body?.yieldQty || 1);
    const existing = await db.get('SELECT * FROM recipes WHERE menu_item_id = ?', [menuItemId]);
    let id;
    if (existing) {
      id = existing.id;
      await db.run(
        'UPDATE recipes SET name = ?, yield_qty = ?, notes = ?, updated_at = ?, deleted = 0 WHERE id = ?',
        [name, yieldQty, clean(req.body?.notes), now, id],
      );
    } else {
      const row = await db.get(
        `INSERT INTO recipes (sync_id, menu_item_id, name, yield_qty, notes, created_at, updated_at, deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0) RETURNING id`,
        [crypto.randomUUID(), menuItemId, name, yieldQty, clean(req.body?.notes), now, now],
      );
      id = row.id;
    }
    await auth.audit(db, req.user, 'recipe.save', 'recipe', id, { menuItemId }, req);
    return res.json({ id });
  }));

  router.get('/recipes/:id/lines', guard('inventory.view'), asyncRoute(async (req, res) => {
    return res.json({ lines: await inventory.getRecipeLines(db, asInt(req.params.id)) });
  }));

  router.post('/recipes/:id/lines', guard('inventory.manage'), asyncRoute(async (req, res) => {
    const recipeId = asInt(req.params.id);
    const recipe = await db.get('SELECT * FROM recipes WHERE id = ? AND deleted = 0', [recipeId]);
    if (!recipe) return bad(res, 'Recipe not found.', 404);
    const ingredientId = asInt(req.body?.ingredientId);
    const ingredient = await db.get('SELECT * FROM ingredients WHERE id = ? AND deleted = 0', [ingredientId]);
    if (!ingredient) return bad(res, 'Ingredient not found.', 404);
    const row = await db.get(
      `INSERT INTO recipe_ingredients (recipe_id, ingredient_id, quantity, unit, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id`,
      [recipeId, ingredientId, Number(req.body?.quantity || 0), clean(req.body?.unit) || ingredient.unit, nowIso()],
    );
    await auth.audit(db, req.user, 'recipe.line.add', 'recipe', recipeId, { ingredientId }, req);
    return res.status(201).json({ line: { id: row.id } });
  }));

  router.delete('/recipes/lines/:id', guard('inventory.manage'), asyncRoute(async (req, res) => {
    const id = asInt(req.params.id);
    await db.run('DELETE FROM recipe_ingredients WHERE id = ?', [id]);
    await auth.audit(db, req.user, 'recipe.line.delete', 'recipe_line', id, null, req);
    return res.json({ ok: true });
  }));

  router.get('/suppliers', guard('purchasing.view'), asyncRoute(async (req, res) => {
    const rows = await db.all('SELECT * FROM suppliers WHERE deleted = 0 ORDER BY name');
    return res.json({
      suppliers: rows.map((row) => ({
        id: row.id,
        uuid: row.sync_id,
        name: row.name,
        contactName: row.contact_name,
        phone: row.phone,
        email: row.email,
        address: row.address,
        taxNumber: row.tax_number,
        notes: row.notes,
        active: Boolean(row.active),
        createdAt: row.created_at,
      })),
    });
  }));

  router.post('/suppliers', guard('purchasing.manage'), asyncRoute(async (req, res) => {
    const name = clean(req.body?.name);
    if (!name) return bad(res, 'Supplier name is required.');
    const now = nowIso();
    const row = await db.get(
      `INSERT INTO suppliers (sync_id, name, contact_name, phone, email, address, tax_number, notes, active, created_at, updated_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0) RETURNING id`,
      [crypto.randomUUID(), name, clean(req.body?.contactName), clean(req.body?.phone), clean(req.body?.email), clean(req.body?.address), clean(req.body?.taxNumber), clean(req.body?.notes), now, now],
    );
    await auth.audit(db, req.user, 'supplier.create', 'supplier', row.id, { name }, req);
    return res.status(201).json({ supplier: { id: row.id, name } });
  }));

  router.post('/suppliers/:id', guard('purchasing.manage'), asyncRoute(async (req, res) => {
    const id = asInt(req.params.id);
    const supplier = await db.get('SELECT * FROM suppliers WHERE id = ? AND deleted = 0', [id]);
    if (!supplier) return bad(res, 'Supplier not found.', 404);
    await db.run(
      `UPDATE suppliers SET name = ?, contact_name = ?, phone = ?, email = ?, address = ?, tax_number = ?, notes = ?, active = ?, updated_at = ?
       WHERE id = ?`,
      [
        clean(req.body?.name) || supplier.name,
        req.body?.contactName === undefined ? supplier.contact_name : clean(req.body.contactName),
        req.body?.phone === undefined ? supplier.phone : clean(req.body.phone),
        req.body?.email === undefined ? supplier.email : clean(req.body.email),
        req.body?.address === undefined ? supplier.address : clean(req.body.address),
        req.body?.taxNumber === undefined ? supplier.tax_number : clean(req.body.taxNumber),
        req.body?.notes === undefined ? supplier.notes : clean(req.body.notes),
        req.body?.active === undefined ? supplier.active : (asBool(req.body.active, true) ? 1 : 0),
        nowIso(),
        id,
      ],
    );
    await auth.audit(db, req.user, 'supplier.update', 'supplier', id, null, req);
    return res.json({ ok: true });
  }));

  router.post('/suppliers/:id/toggle', guard('purchasing.manage'), asyncRoute(async (req, res) => {
    const id = asInt(req.params.id);
    const supplier = await db.get('SELECT * FROM suppliers WHERE id = ? AND deleted = 0', [id]);
    if (!supplier) return bad(res, 'Supplier not found.', 404);
    const active = supplier.active ? 0 : 1;
    await db.run('UPDATE suppliers SET active = ?, updated_at = ? WHERE id = ?', [active, nowIso(), id]);
    return res.json({ ok: true, active: Boolean(active) });
  }));

  router.get('/purchases', guard('purchasing.view'), asyncRoute(async (req, res) => {
    const status = clean(req.query.status);
    const supplierId = req.query.supplierId ? asInt(req.query.supplierId) : null;
    const params = [];
    let where = 'WHERE p.deleted = 0';
    if (status) {
      where += ' AND p.status = ?';
      params.push(status);
    }
    if (supplierId) {
      where += ' AND p.supplier_id = ?';
      params.push(supplierId);
    }
    const rows = await db.all(
      `SELECT p.*, s.name AS supplier_name FROM purchase_orders p
       LEFT JOIN suppliers s ON s.id = p.supplier_id
       ${where} ORDER BY p.id DESC LIMIT 100`,
      params,
    );
    return res.json({
      purchases: rows.map((row) => ({
        id: row.id,
        uuid: row.sync_id,
        poNumber: row.po_number,
        supplierId: row.supplier_id,
        supplierName: row.supplier_name,
        status: row.status,
        orderDate: row.order_date,
        expectedAt: row.expected_at,
        receivedAt: row.received_at,
        subtotal: money(row.subtotal),
        taxTotal: money(row.tax_total),
        total: money(row.total),
        notes: row.notes,
        createdAt: row.created_at,
      })),
    });
  }));

  router.get('/purchases/:id', guard('purchasing.view'), asyncRoute(async (req, res) => {
    const id = asInt(req.params.id);
    const purchase = await db.get(
      `SELECT p.*, s.name AS supplier_name FROM purchase_orders p LEFT JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = ?`,
      [id],
    );
    if (!purchase) return bad(res, 'Purchase order not found.', 404);
    const items = await db.all(
      `SELECT pi.*, i.name AS ingredient_name, i.unit AS ingredient_unit FROM purchase_order_items pi
       LEFT JOIN ingredients i ON i.id = pi.ingredient_id WHERE pi.purchase_order_id = ? ORDER BY pi.id`,
      [id],
    );
    return res.json({
      purchase: {
        id: purchase.id,
        uuid: purchase.sync_id,
        poNumber: purchase.po_number,
        supplierId: purchase.supplier_id,
        supplierName: purchase.supplier_name,
        status: purchase.status,
        orderDate: purchase.order_date,
        expectedAt: purchase.expected_at,
        receivedAt: purchase.received_at,
        subtotal: money(purchase.subtotal),
        taxTotal: money(purchase.tax_total),
        total: money(purchase.total),
        notes: purchase.notes,
        items: items.map((item) => ({
          id: item.id,
          ingredientId: item.ingredient_id,
          ingredientName: item.ingredient_name,
          description: item.description,
          quantity: Number(item.quantity),
          unitCost: money(item.unit_cost),
          lineTotal: money(item.line_total),
          receivedQty: Number(item.received_qty),
          unit: item.ingredient_unit,
        })),
      },
    });
  }));

  router.post('/purchases', guard('purchasing.manage'), asyncRoute(async (req, res) => {
    const supplierId = asInt(req.body?.supplierId);
    const supplier = await db.get('SELECT * FROM suppliers WHERE id = ? AND deleted = 0', [supplierId]);
    if (!supplier) return bad(res, 'Supplier not found.', 404);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return bad(res, 'Add at least one purchase order item.');
    const number = await nextCounter(db, 'PO');
    const poNumber = `PO-${String(number).padStart(4, '0')}`;
    const now = nowIso();
    let subtotal = 0;
    const resolved = items.map((item) => {
      const quantity = Number(item.quantity || 0);
      const unitCost = Number(item.unitCost || 0);
      const lineTotal = money(quantity * unitCost);
      subtotal = money(subtotal + lineTotal);
      return { ...item, quantity, unitCost, lineTotal };
    });
    const row = await db.get(
      `INSERT INTO purchase_orders (sync_id, po_number, supplier_id, status, order_date, expected_at, subtotal, tax_total, total, notes, created_by, created_at, updated_at, deleted)
       VALUES (?, ?, ?, 'DRAFT', ?, ?, ?, 0, ?, ?, ?, ?, ?, 0) RETURNING id`,
      [crypto.randomUUID(), poNumber, supplierId, now, clean(req.body?.expectedAt), subtotal, subtotal, clean(req.body?.notes), req.user.id || null, now, now],
    );
    for (const item of resolved) {
      await db.run(
        `INSERT INTO purchase_order_items (purchase_order_id, ingredient_id, description, quantity, unit_cost, line_total, received_qty, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
        [row.id, item.ingredientId ? asInt(item.ingredientId) : null, clean(item.description), item.quantity, item.unitCost, item.lineTotal, now],
      );
    }
    await auth.audit(db, req.user, 'purchase.create', 'purchase_order', row.id, { poNumber, subtotal }, req);
    return res.status(201).json({ purchase: { id: row.id, poNumber, total: subtotal } });
  }));

  router.post('/purchases/:id/items', guard('purchasing.manage'), asyncRoute(async (req, res) => {
    const id = asInt(req.params.id);
    const purchase = await db.get('SELECT * FROM purchase_orders WHERE id = ? AND deleted = 0', [id]);
    if (!purchase) return bad(res, 'Purchase order not found.', 404);
    const quantity = Number(req.body?.quantity || 0);
    const unitCost = Number(req.body?.unitCost || 0);
    const lineTotal = money(quantity * unitCost);
    await db.run(
      `INSERT INTO purchase_order_items (purchase_order_id, ingredient_id, description, quantity, unit_cost, line_total, received_qty, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      [id, req.body?.ingredientId ? asInt(req.body.ingredientId) : null, clean(req.body?.description), quantity, unitCost, lineTotal, nowIso()],
    );
    await db.run(
      'UPDATE purchase_orders SET subtotal = subtotal + ?, total = total + ?, updated_at = ? WHERE id = ?',
      [lineTotal, lineTotal, nowIso(), id],
    );
    return res.json({ ok: true, lineTotal });
  }));

  router.post('/purchases/:id/receive', guard('purchasing.manage'), asyncRoute(async (req, res) => {
    const id = asInt(req.params.id);
    const purchase = await db.get('SELECT * FROM purchase_orders WHERE id = ? AND deleted = 0', [id]);
    if (!purchase) return bad(res, 'Purchase order not found.', 404);
    const received = Array.isArray(req.body?.items) ? req.body.items : null;
    const items = await db.all('SELECT * FROM purchase_order_items WHERE purchase_order_id = ?', [id]);
    const now = nowIso();
    let fullyReceived = true;
    for (const item of items) {
      const requested = received ? received.find((entry) => asInt(entry.id) === item.id) : null;
      const qty = received ? Number(requested?.receivedQty || 0) : Math.max(0, Number(item.quantity) - Number(item.received_qty));
      if (qty <= 0) {
        if (Number(item.received_qty) < Number(item.quantity)) fullyReceived = false;
        continue;
      }
      await db.run(
        'UPDATE purchase_order_items SET received_qty = received_qty + ? WHERE id = ?',
        [qty, item.id],
      );
      if (item.ingredient_id) {
        await inventory.adjustIngredientStock(db, {
          ingredientId: item.ingredient_id,
          quantity: qty,
          unitCost: item.unit_cost,
          referenceType: 'PURCHASE_ORDER',
          referenceId: purchase.po_number,
          notes: `Received ${purchase.po_number}`,
          userId: req.user.id || null,
        });
      }
      if (Number(item.received_qty) + qty < Number(item.quantity)) fullyReceived = false;
    }
    const status = fullyReceived ? 'RECEIVED' : 'PARTIAL';
    await db.run('UPDATE purchase_orders SET status = ?, received_at = ?, updated_at = ? WHERE id = ?', [status, status === 'RECEIVED' ? now : null, now, id]);
    await auth.audit(db, req.user, 'purchase.receive', 'purchase_order', id, { status }, req);
    return res.json({ ok: true, status });
  }));

  router.post('/purchases/:id/cancel', guard('purchasing.manage'), asyncRoute(async (req, res) => {
    const id = asInt(req.params.id);
    const purchase = await db.get('SELECT * FROM purchase_orders WHERE id = ? AND deleted = 0', [id]);
    if (!purchase) return bad(res, 'Purchase order not found.', 404);
    if (purchase.status === 'RECEIVED') return bad(res, 'Received purchase orders cannot be cancelled.');
    await db.run('UPDATE purchase_orders SET status = \'CANCELLED\', updated_at = ? WHERE id = ?', [nowIso(), id]);
    await auth.audit(db, req.user, 'purchase.cancel', 'purchase_order', id, null, req);
    return res.json({ ok: true });
  }));

  router.get('/expenses', guard('expenses.view'), asyncRoute(async (req, res) => {
    const params = [];
    let where = 'WHERE e.deleted = 0';
    if (req.query.from) {
      where += ' AND e.paid_at >= ?';
      params.push(clean(req.query.from));
    }
    if (req.query.to) {
      where += ' AND e.paid_at <= ?';
      params.push(clean(req.query.to));
    }
    if (req.query.category) {
      where += ' AND e.category = ?';
      params.push(clean(req.query.category));
    }
    const rows = await db.all(
      `SELECT e.*, s.name AS supplier_name, u.name AS recorded_by_name FROM expenses e
       LEFT JOIN suppliers s ON s.id = e.supplier_id
       LEFT JOIN users u ON u.id = e.recorded_by
       ${where} ORDER BY e.paid_at DESC LIMIT 200`,
      params,
    );
    return res.json({
      expenses: rows.map((row) => ({
        id: row.id,
        uuid: row.sync_id,
        category: row.category,
        amount: money(row.amount),
        note: row.note,
        paidAt: row.paid_at,
        supplierId: row.supplier_id,
        supplierName: row.supplier_name,
        paymentMethod: row.payment_method,
        reference: row.reference,
        status: row.status,
        recordedBy: row.recorded_by,
        recordedByName: row.recorded_by_name,
      })),
      total: money(rows.reduce((sum, row) => sum + Number(row.amount), 0)),
    });
  }));

  router.post('/expenses', guard('expenses.manage'), asyncRoute(async (req, res) => {
    const amount = Number(req.body?.amount || 0);
    if (amount <= 0) return bad(res, 'Expense amount must be greater than zero.');
    const now = nowIso();
    const row = await db.get(
      `INSERT INTO expenses (sync_id, category, amount, note, paid_at, supplier_id, payment_method, reference, recorded_by, status, created_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'POSTED', ?, 0) RETURNING id`,
      [
        crypto.randomUUID(),
        clean(req.body?.category) || 'General',
        amount,
        clean(req.body?.note),
        clean(req.body?.paidAt) || now,
        req.body?.supplierId ? asInt(req.body.supplierId) : null,
        clean(req.body?.paymentMethod) || 'CASH',
        clean(req.body?.reference),
        req.user.id || null,
        now,
      ],
    );
    await auth.audit(db, req.user, 'expense.create', 'expense', row.id, { amount }, req);
    return res.status(201).json({ expense: { id: row.id, amount } });
  }));

  router.delete('/expenses/:id', guard('expenses.manage'), asyncRoute(async (req, res) => {
    const id = asInt(req.params.id);
    await db.run('UPDATE expenses SET deleted = 1 WHERE id = ?', [id]);
    await auth.audit(db, req.user, 'expense.delete', 'expense', id, null, req);
    return res.json({ ok: true });
  }));

  router.get('/audit', guard('audit.view'), asyncRoute(async (req, res) => {
    const page = Math.max(1, asInt(req.query.page, 1));
    const limit = Math.min(asInt(req.query.limit, 50), 200);
    const params = [];
    let where = 'WHERE 1 = 1';
    if (req.query.q) {
      where += ' AND (LOWER(action) LIKE LOWER(?) OR LOWER(entity) LIKE LOWER(?) OR LOWER(user_name) LIKE LOWER(?))';
      params.push(`%${clean(req.query.q)}%`, `%${clean(req.query.q)}%`, `%${clean(req.query.q)}%`);
    }
    if (req.query.userId) {
      where += ' AND user_id = ?';
      params.push(asInt(req.query.userId));
    }
    if (req.query.action) {
      where += ' AND action = ?';
      params.push(clean(req.query.action));
    }
    if (req.query.entity) {
      where += ' AND entity = ?';
      params.push(clean(req.query.entity));
    }
    if (req.query.from) {
      where += ' AND created_at >= ?';
      params.push(clean(req.query.from));
    }
    if (req.query.to) {
      where += ' AND created_at <= ?';
      params.push(clean(req.query.to));
    }
    const total = await db.get(`SELECT COUNT(*) AS count FROM audit_logs ${where}`, params);
    const rows = await db.all(
      `SELECT * FROM audit_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit],
    );
    return res.json({
      logs: rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        userName: row.user_name,
        action: row.action,
        entity: row.entity,
        entityId: row.entity_id,
        details: row.details,
        ip: row.ip,
        userAgent: row.user_agent,
        createdAt: row.created_at,
      })),
      total: Number(total.count),
      page,
      limit,
    });
  }));

  router.get('/settings', guard('settings.manage'), asyncRoute(async (req, res) => {
    const settings = await db.get('SELECT * FROM settings WHERE id = 1');
    return res.json({ settings });
  }));

  router.post('/settings', guard('settings.manage'), asyncRoute(async (req, res) => {
    const current = await db.get('SELECT * FROM settings WHERE id = 1');
    const body = req.body || {};
    await db.run(
      `UPDATE settings SET restaurant_name = ?, currency = ?, tax_rate = ?, service_charge_rate = ?,
         service_charge_enabled = ?, tax_enabled = ?, receipt_footer = ?, address = ?, phone = ?, email = ?,
         logo_url = ?, receipt_header = ?, invoice_prefix = ?, tax_number = ?, timezone = ?,
         deduct_stock_on_submit = ?, low_stock_alerts = ?, updated_at = ? WHERE id = 1`,
      [
        clean(body.restaurantName) || current.restaurant_name,
        String(body.currency || current.currency).toUpperCase(),
        body.taxRate == null ? current.tax_rate : Number(body.taxRate),
        body.serviceChargeRate == null ? current.service_charge_rate : Number(body.serviceChargeRate),
        body.serviceChargeEnabled == null ? current.service_charge_enabled : (asBool(body.serviceChargeEnabled, true) ? 1 : 0),
        body.taxEnabled == null ? current.tax_enabled : (asBool(body.taxEnabled, true) ? 1 : 0),
        body.receiptFooter === undefined ? current.receipt_footer : clean(body.receiptFooter),
        body.address === undefined ? current.address : clean(body.address),
        body.phone === undefined ? current.phone : clean(body.phone),
        body.email === undefined ? current.email : clean(body.email),
        body.logoUrl === undefined ? current.logo_url : clean(body.logoUrl),
        body.receiptHeader === undefined ? current.receipt_header : clean(body.receiptHeader),
        body.invoicePrefix === undefined ? current.invoice_prefix : clean(body.invoicePrefix),
        body.taxNumber === undefined ? current.tax_number : clean(body.taxNumber),
        body.timezone === undefined ? current.timezone : clean(body.timezone),
        body.deductStockOnSubmit == null ? current.deduct_stock_on_submit : (asBool(body.deductStockOnSubmit, true) ? 1 : 0),
        body.lowStockAlerts == null ? current.low_stock_alerts : (asBool(body.lowStockAlerts, true) ? 1 : 0),
        nowIso(),
      ],
    );
    await auth.audit(db, req.user, 'settings.update', 'settings', 1, null, req);
    return res.json({ ok: true });
  }));

  router.get('/floors', guard('floor.view'), asyncRoute(async (req, res) => {
    const floors = await db.all('SELECT * FROM floors WHERE deleted = 0 ORDER BY sort, id');
    const output = [];
    for (const floor of floors) {
      const sections = await db.all('SELECT * FROM sections WHERE floor_id = ? AND deleted = 0 ORDER BY sort, id', [floor.id]);
      output.push({
        id: floor.id,
        uuid: floor.sync_id,
        branchId: floor.branch_id,
        name: floor.name,
        sort: floor.sort,
        active: Boolean(floor.active),
        sections: sections.map((section) => ({ id: section.id, uuid: section.sync_id, name: section.name, sort: section.sort })),
      });
    }
    return res.json({ floors: output });
  }));

  router.post('/floors', guard('floor.manage'), asyncRoute(async (req, res) => {
    const name = clean(req.body?.name);
    if (!name) return bad(res, 'Floor name is required.');
    const row = await db.get(
      `INSERT INTO floors (sync_id, branch_id, name, sort, active, updated_at, deleted)
       VALUES (?, ?, ?, ?, 1, ?, 0) RETURNING id`,
      [crypto.randomUUID(), req.body?.branchId ? asInt(req.body.branchId) : null, name, asInt(req.body?.sort, 0), nowIso()],
    );
    await auth.audit(db, req.user, 'floor.create', 'floor', row.id, { name }, req);
    return res.status(201).json({ floor: { id: row.id, name } });
  }));

  router.post('/sections', guard('floor.manage'), asyncRoute(async (req, res) => {
    const name = clean(req.body?.name);
    const floorId = asInt(req.body?.floorId);
    if (!name || !floorId) return bad(res, 'Section name and floor are required.');
    const row = await db.get(
      `INSERT INTO sections (sync_id, floor_id, name, sort, updated_at, deleted)
       VALUES (?, ?, ?, ?, ?, 0) RETURNING id`,
      [crypto.randomUUID(), floorId, name, asInt(req.body?.sort, 0), nowIso()],
    );
    return res.status(201).json({ section: { id: row.id, name } });
  }));

  router.get('/tables', guard('floor.view'), asyncRoute(async (req, res) => {
    const sectionId = req.query.sectionId ? asInt(req.query.sectionId) : null;
    const params = [];
    let where = 'WHERE t.deleted = 0';
    if (sectionId) {
      where += ' AND t.section_id = ?';
      params.push(sectionId);
    }
    const rows = await db.all(
      `SELECT t.*, s.name AS section_name, f.name AS floor_name FROM dining_tables t
       LEFT JOIN sections s ON s.id = t.section_id
       LEFT JOIN floors f ON f.id = t.floor_id
       ${where} ORDER BY t.number`,
      params,
    );
    return res.json({
      tables: rows.map((row) => ({
        id: row.id,
        uuid: row.sync_id,
        number: row.number,
        name: row.name,
        capacity: row.capacity,
        status: row.status,
        qrToken: row.qr_token,
        sectionId: row.section_id,
        sectionName: row.section_name,
        floorId: row.floor_id,
        floorName: row.floor_name,
        positionX: row.position_x,
        positionY: row.position_y,
      })),
    });
  }));

  router.post('/tables', guard('floor.manage'), asyncRoute(async (req, res) => {
    const number = clean(req.body?.number);
    const name = clean(req.body?.name) || `Table ${number}`;
    if (!number) return bad(res, 'Table number is required.');
    const existing = await db.get('SELECT id FROM dining_tables WHERE number = ? AND deleted = 0', [number]);
    if (existing) return bad(res, 'A table with that number already exists.', 409);
    const now = nowIso();
    const row = await db.get(
      `INSERT INTO dining_tables (sync_id, number, name, capacity, status, qr_token, branch_id, floor_id, section_id, position_x, position_y, updated_at, deleted)
       VALUES (?, ?, ?, ?, 'AVAILABLE', ?, ?, ?, ?, ?, ?, ?, 0) RETURNING id`,
      [
        crypto.randomUUID(), number, name, asInt(req.body?.capacity, 4), crypto.randomUUID(),
        req.body?.branchId ? asInt(req.body.branchId) : null,
        req.body?.floorId ? asInt(req.body.floorId) : null,
        req.body?.sectionId ? asInt(req.body.sectionId) : null,
        asInt(req.body?.positionX, 0), asInt(req.body?.positionY, 0), now,
      ],
    );
    await enqueueOutbox(db, 'table', row.id, 'upsert', { id: row.id, number, name });
    await auth.audit(db, req.user, 'table.create', 'table', row.id, { number }, req);
    return res.status(201).json({ table: { id: row.id, number, name } });
  }));

  router.post('/tables/:id/status', guard('floor.manage'), asyncRoute(async (req, res) => {
    const id = asInt(req.params.id);
    const status = clean(req.body?.status) || 'AVAILABLE';
    const allowed = ['AVAILABLE', 'OCCUPIED', 'RESERVED', 'CLEANING', 'MAINTENANCE'];
    if (!allowed.includes(status)) return bad(res, 'Unknown table status.');
    await db.run('UPDATE dining_tables SET status = ?, updated_at = ? WHERE id = ?', [status, nowIso(), id]);
    await auth.audit(db, req.user, 'table.status', 'table', id, { status }, req);
    return res.json({ ok: true });
  }));

  router.get('/orders', guard('orders.view'), asyncRoute(async (req, res) => {
    const limit = Math.min(asInt(req.query.limit, 60), 200);
    const params = [];
    let where = 'WHERE o.deleted = 0';
    if (req.query.open === '1') where += " AND o.status NOT IN ('COMPLETED','CANCELLED','VOID')";
    if (req.query.status) {
      where += ' AND o.status = ?';
      params.push(clean(req.query.status));
    }
    if (req.query.q) {
      where += ' AND (LOWER(o.order_number) LIKE LOWER(?) OR LOWER(t.number) LIKE LOWER(?))';
      params.push(`%${clean(req.query.q)}%`, `%${clean(req.query.q)}%`);
    }
    const rows = await db.all(
      `SELECT o.*, t.number AS table_number, c.name AS customer_name FROM orders o
       LEFT JOIN dining_tables t ON t.id = o.table_id
       LEFT JOIN customers c ON c.id = o.customer_id
       ${where} ORDER BY o.id DESC LIMIT ?`,
      [...params, limit],
    );
    const orders = [];
    for (const row of rows) {
      const items = await db.all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', [row.id]);
      const payments = await db.all('SELECT * FROM payments WHERE order_id = ? ORDER BY id', [row.id]);
      orders.push({
        id: row.id,
        uuid: row.sync_id,
        orderNumber: row.order_number,
        type: row.type,
        status: row.status,
        tableNumber: row.table_number,
        customerName: row.customer_name,
        guestCount: row.guest_count,
        subtotal: money(row.subtotal),
        taxTotal: money(row.tax_total),
        serviceTotal: money(row.service_total),
        total: money(row.total),
        paidTotal: money(row.paid_total),
        notes: row.notes,
        createdAt: row.created_at,
        inventoryDeductedAt: row.inventory_deducted_at,
        items: items.map((item) => ({
          id: item.id,
          uuid: item.sync_id,
          name: item.name,
          quantity: item.quantity,
          unitPrice: money(item.unit_price),
          lineTotal: money(item.line_total),
          station: item.station,
          status: item.status,
        })),
        payments: payments.map((payment) => ({
          id: payment.id,
          uuid: payment.sync_id,
          receiptNumber: payment.receipt_number,
          methodCode: payment.method_code,
          amount: money(payment.amount),
          createdAt: payment.created_at,
        })),
      });
    }
    return res.json({ orders });
  }));

  router.get('/orders/:syncId', guard('orders.view'), asyncRoute(async (req, res) => {
    const row = await db.get(
      `SELECT o.*, t.number AS table_number, c.name AS customer_name FROM orders o
       LEFT JOIN dining_tables t ON t.id = o.table_id
       LEFT JOIN customers c ON c.id = o.customer_id
       WHERE o.sync_id = ?`,
      [req.params.syncId],
    );
    if (!row) return bad(res, 'Order not found.', 404);
    const items = await db.all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', [row.id]);
    const payments = await db.all('SELECT * FROM payments WHERE order_id = ? ORDER BY id', [row.id]);
    return res.json({
      order: {
        id: row.id,
        uuid: row.sync_id,
        orderNumber: row.order_number,
        type: row.type,
        status: row.status,
        tableNumber: row.table_number,
        customerId: row.customer_id,
        customerName: row.customer_name,
        guestCount: row.guest_count,
        subtotal: money(row.subtotal),
        discountTotal: money(row.discount_total),
        taxTotal: money(row.tax_total),
        serviceTotal: money(row.service_total),
        total: money(row.total),
        paidTotal: money(row.paid_total),
        notes: row.notes,
        createdAt: row.created_at,
        inventoryDeductedAt: row.inventory_deducted_at,
        items: items.map((item) => ({
          id: item.id,
          uuid: item.sync_id,
          menuItemId: item.menu_item_id,
          name: item.name,
          quantity: item.quantity,
          unitPrice: money(item.unit_price),
          lineTotal: money(item.line_total),
          station: item.station,
          status: item.status,
          notes: item.notes,
        })),
        payments: payments.map((payment) => ({
          id: payment.id,
          uuid: payment.sync_id,
          receiptNumber: payment.receipt_number,
          methodCode: payment.method_code,
          amount: money(payment.amount),
          tendered: payment.tendered == null ? null : money(payment.tendered),
          changeDue: payment.change_due == null ? null : money(payment.change_due),
          createdAt: payment.created_at,
        })),
      },
    });
  }));

  router.post('/orders/:syncId/status', guard('orders.manage'), asyncRoute(async (req, res) => {
    const status = clean(req.body?.status);
    const allowed = ['SUBMITTED', 'PREPARING', 'READY', 'SERVED', 'COMPLETED', 'CANCELLED', 'VOID', 'PAID', 'PARTIALLY_PAID'];
    if (!allowed.includes(status)) return bad(res, 'Unknown order status.');
    const order = await db.get('SELECT * FROM orders WHERE sync_id = ? AND deleted = 0', [req.params.syncId]);
    if (!order) return bad(res, 'Order not found.', 404);
    await db.run('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?', [status, nowIso(), order.id]);
    if (status === 'CANCELLED' || status === 'VOID') {
      await inventory.restoreOrderInventory(db, order, req.user.id || null);
    }
    await auth.audit(db, req.user, 'order.status', 'order', order.sync_id, { status }, req);
    return res.json({ ok: true, status });
  }));

  router.post('/orders/:syncId/void', guard('orders.cancel'), asyncRoute(async (req, res) => {
    const order = await db.get('SELECT * FROM orders WHERE sync_id = ? AND deleted = 0', [req.params.syncId]);
    if (!order) return bad(res, 'Order not found.', 404);
    await db.run(
      'UPDATE orders SET status = \'VOID\', void_reason = ?, updated_at = ? WHERE id = ?',
      [clean(req.body?.reason), nowIso(), order.id],
    );
    await inventory.restoreOrderInventory(db, order, req.user.id || null);
    await auth.audit(db, req.user, 'order.void', 'order', order.sync_id, { reason: req.body?.reason }, req);
    return res.json({ ok: true });
  }));

  router.post('/orders/:syncId/refund', guard('billing.refund'), asyncRoute(async (req, res) => {
    const order = await db.get('SELECT * FROM orders WHERE sync_id = ? AND deleted = 0', [req.params.syncId]);
    if (!order) return bad(res, 'Order not found.', 404);
    const amount = money(req.body?.amount);
    if (amount <= 0) return bad(res, 'Refund amount must be greater than zero.');
    if (amount > Number(order.paid_total) + 0.001) return bad(res, 'Refund exceeds amount paid.');
    const now = nowIso();
    const refund = await db.get(
      `INSERT INTO refunds (sync_id, order_id, order_sync_id, amount, reason, method_code, processed_by, created_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0) RETURNING id`,
      [crypto.randomUUID(), order.id, order.sync_id, amount, clean(req.body?.reason), clean(req.body?.methodCode) || 'CASH', req.user.id || null, now],
    );
    const paidTotal = money(Number(order.paid_total) - amount);
    await db.run('UPDATE orders SET paid_total = ?, updated_at = ? WHERE id = ?', [paidTotal, now, order.id]);
    await auth.audit(db, req.user, 'order.refund', 'order', order.sync_id, { amount }, req);
    return res.json({ ok: true, refundId: refund.id, paidTotal });
  }));

  router.post('/orders/:syncId/invoice', guard('billing.view'), asyncRoute(async (req, res) => {
    const order = await db.get('SELECT * FROM orders WHERE sync_id = ? AND deleted = 0', [req.params.syncId]);
    if (!order) return bad(res, 'Order not found.', 404);
    const existing = await db.get('SELECT * FROM invoices WHERE order_sync_id = ? AND deleted = 0', [order.sync_id]);
    if (existing) return res.json({ invoice: { id: existing.id, invoiceNumber: existing.invoice_number } });
    const settings = await db.get('SELECT * FROM settings WHERE id = 1');
    const prefix = settings?.invoice_prefix || 'INV';
    const number = await nextCounter(db, 'INV');
    const invoiceNumber = `${prefix}-${String(number).padStart(4, '0')}`;
    const now = nowIso();
    const row = await db.get(
      `INSERT INTO invoices (sync_id, invoice_number, order_id, order_sync_id, customer_id, subtotal, tax_total, total, paid_total, status, issued_at, notes, created_by, created_at, updated_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0) RETURNING id`,
      [
        crypto.randomUUID(), invoiceNumber, order.id, order.sync_id, order.customer_id || null,
        order.subtotal, order.tax_total, order.total, order.paid_total,
        Number(order.paid_total) + 0.001 >= Number(order.total) ? 'PAID' : 'ISSUED',
        now, clean(req.body?.notes), req.user.id || null, now, now,
      ],
    );
    await db.run('UPDATE orders SET invoice_id = ?, updated_at = ? WHERE id = ?', [row.id, now, order.id]);
    await auth.audit(db, req.user, 'invoice.create', 'invoice', row.id, { invoiceNumber }, req);
    return res.status(201).json({ invoice: { id: row.id, invoiceNumber, total: money(order.total) } });
  }));

  router.get('/invoices', guard('billing.view'), asyncRoute(async (req, res) => {
    const params = [];
    let where = 'WHERE i.deleted = 0';
    if (req.query.status) {
      where += ' AND i.status = ?';
      params.push(clean(req.query.status));
    }
    if (req.query.customerId) {
      where += ' AND i.customer_id = ?';
      params.push(asInt(req.query.customerId));
    }
    const rows = await db.all(
      `SELECT i.*, c.name AS customer_name, o.order_number FROM invoices i
       LEFT JOIN customers c ON c.id = i.customer_id
       LEFT JOIN orders o ON o.id = i.order_id
       ${where} ORDER BY i.id DESC LIMIT 200`,
      params,
    );
    return res.json({
      invoices: rows.map((row) => ({
        id: row.id,
        uuid: row.sync_id,
        invoiceNumber: row.invoice_number,
        orderNumber: row.order_number,
        customerName: row.customer_name,
        subtotal: money(row.subtotal),
        taxTotal: money(row.tax_total),
        total: money(row.total),
        paidTotal: money(row.paid_total),
        status: row.status,
        issuedAt: row.issued_at,
        dueAt: row.due_at,
      })),
    });
  }));

  router.get('/invoices/:id', guard('billing.view'), asyncRoute(async (req, res) => {
    const id = asInt(req.params.id);
    const invoice = await db.get(
      `SELECT i.*, c.name AS customer_name, c.phone AS customer_phone, o.order_number FROM invoices i
       LEFT JOIN customers c ON c.id = i.customer_id
       LEFT JOIN orders o ON o.id = i.order_id WHERE i.id = ?`,
      [id],
    );
    if (!invoice) return bad(res, 'Invoice not found.', 404);
    const items = invoice.order_id
      ? await db.all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', [invoice.order_id])
      : [];
    return res.json({
      invoice: {
        id: invoice.id,
        uuid: invoice.sync_id,
        invoiceNumber: invoice.invoice_number,
        orderNumber: invoice.order_number,
        customerName: invoice.customer_name,
        customerPhone: invoice.customer_phone,
        subtotal: money(invoice.subtotal),
        taxTotal: money(invoice.tax_total),
        total: money(invoice.total),
        paidTotal: money(invoice.paid_total),
        status: invoice.status,
        issuedAt: invoice.issued_at,
        dueAt: invoice.due_at,
        notes: invoice.notes,
        items: items.map((item) => ({
          name: item.name,
          quantity: item.quantity,
          unitPrice: money(item.unit_price),
          lineTotal: money(item.line_total),
        })),
      },
    });
  }));

  router.post('/invoices/:id/pay', guard('billing.pay'), asyncRoute(async (req, res) => {
    const id = asInt(req.params.id);
    const invoice = await db.get('SELECT * FROM invoices WHERE id = ? AND deleted = 0', [id]);
    if (!invoice) return bad(res, 'Invoice not found.', 404);
    const amount = money(req.body?.amount);
    if (amount <= 0) return bad(res, 'Payment amount must be greater than zero.');
    const paidTotal = money(Number(invoice.paid_total) + amount);
    const status = paidTotal + 0.001 >= Number(invoice.total) ? 'PAID' : 'PARTIAL';
    await db.run('UPDATE invoices SET paid_total = ?, status = ?, updated_at = ? WHERE id = ?', [paidTotal, status, nowIso(), id]);
    await auth.audit(db, req.user, 'invoice.pay', 'invoice', id, { amount }, req);
    return res.json({ ok: true, paidTotal, status });
  }));

  router.post('/invoices/:id/void', guard('billing.refund'), asyncRoute(async (req, res) => {
    const id = asInt(req.params.id);
    await db.run('UPDATE invoices SET status = \'VOID\', updated_at = ? WHERE id = ?', [nowIso(), id]);
    await auth.audit(db, req.user, 'invoice.void', 'invoice', id, null, req);
    return res.json({ ok: true });
  }));

  return router;
}

module.exports = { createAuthRouter, createErpRouter };
