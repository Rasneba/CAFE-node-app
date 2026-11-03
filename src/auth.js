const crypto = require('node:crypto');
const config = require('./config');

const SESSION_COOKIE = 'erp_session';

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${key}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, salt, key] = stored.split('$');
  if (!salt || !key) return false;
  try {
    const expected = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(key, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function decodeBase64Url(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function makeToken(user, permissions) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: user.id,
    email: user.email,
    name: user.name,
    permissions: permissions || [],
    isSuperAdmin: Boolean(user.is_super_admin),
    iat: now,
    exp: now + Math.floor(config.sessionTtlMs / 1000),
  };
  const signingInput = base64Url(JSON.stringify(payload));
  const signature = crypto
    .createHmac('sha256', config.sessionSecret)
    .update(signingInput)
    .digest('base64url');
  return `${signingInput}.${signature}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  try {
    const payload = JSON.parse(decodeBase64Url(parts[0]));
    const expected = crypto
      .createHmac('sha256', config.sessionSecret)
      .update(parts[0])
      .digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts[1]))) return null;
    if (payload.exp && Math.floor(Date.now() / 1000) >= payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function getToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  const cookies = req.headers.cookie || '';
  const match = cookies.match(/(?:^|;\s*)erp_session=([^;]+)/);
  return match ? match[1] : null;
}

function basicCredentials(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    return separator === -1 ? { username: decoded, password: '' } : { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}

async function loadUser(db, req) {
  const env = config.isCloud ? 'cloud' : 'local';
  const token = getToken(req);
  if (token) {
    const payload = verifyToken(token);
    if (payload && payload.sub != null) {
      const revoked = await isSessionRevoked(db, token);
      if (revoked) return null;
      const user = await db.get('SELECT * FROM users WHERE id = ? AND deleted = 0', [Number(payload.sub)]);
      if (user) {
        if (!user.active) return null;
        user.permissions = await userPermissions(db, user.id, env);
        return { user, permissions: user.permissions, isSuperAdmin: Boolean(user.is_super_admin), token };
      }
    }
  }

  const basic = basicCredentials(req);
  if (basic) {
    const locked = await isAccountLocked(db, basic.username);
    if (locked) {
      return null;
    }
    const user = await db.get('SELECT * FROM users WHERE LOWER(email) = LOWER(?) AND deleted = 0', [basic.username]);
    if (!user) {
      await recordFailedLogin(db, { email: basic.username, ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress || '', userAgent: req.headers['user-agent'] || '', reason: 'user_not_found' });
      return null;
    }
    if (!user.active) {
      await recordFailedLogin(db, { email: basic.username, ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress || '', userAgent: req.headers['user-agent'] || '', reason: 'account_inactive' });
      return null;
    }
    if (user && verifyPassword(basic.password, user.password_hash)) {
      await recordLogin(db, { userId: user.id, email: user.email, ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress || '', userAgent: req.headers['user-agent'] || '', success: true });
      await db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [new Date().toISOString(), user.id]);
      user.permissions = await userPermissions(db, user.id, env);
      return { user, permissions: user.permissions, isSuperAdmin: Boolean(user.is_super_admin), token: makeToken(user, user.permissions) };
    }
    await recordFailedLogin(db, { email: basic.username, ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress || '', userAgent: req.headers['user-agent'] || '', reason: 'invalid_password' });
    if (config.adminUsername && config.adminPassword && basic.username === config.adminUsername && basic.password === config.adminPassword) {
      return {
        user: { id: 0, name: 'Admin', email: config.adminUsername, is_super_admin: 1, active: 1 },
        permissions: ['*'],
        isSuperAdmin: true,
        token: null,
      };
    }
  }

  return null;
}

async function userPermissions(db, userId, environment = 'both') {
  const envCondition = environment === 'both' ? '' : "AND (rp.environment = ? OR rp.environment = 'both')";
  const params = environment === 'both' ? [userId] : [userId, environment];
  const rows = await db.all(
    `SELECT p.code
     FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id AND r.is_system = 1
     JOIN role_permissions rp ON rp.role_id = r.id
     JOIN permissions p ON p.code = rp.permission_code
     WHERE ur.user_id = ? ${envCondition}`,
    params,
  );
  return rows.map((row) => row.code);
}

function setSessionCookie(res, token) {
  const secure = config.mode === 'cloud' || config.isCloud ? '; Secure' : '';
  res.setHeader(
    'set-cookie',
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(config.sessionTtlMs / 1000)}${secure}`,
  );
}

function clearSessionCookie(res) {
  const secure = config.mode === 'cloud' || config.isCloud ? '; Secure' : '';
  res.setHeader('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

async function authMiddleware(req, res, next) {
  try {
    const auth = await loadUser(require('./db').getDb(), req);
    req.user = auth ? auth.user : null;
    req.permissions = auth ? auth.permissions : [];
    req.isSuperAdmin = auth ? auth.isSuperAdmin : false;
    req.sessionToken = auth ? auth.token : null;
  } catch {
    req.user = null;
    req.permissions = [];
    req.isSuperAdmin = false;
    req.sessionToken = null;
  }
  return next();
}

function requireAuth(options = {}) {
  return (req, res, next) => {
    if (!req.user) {
      if (req.path.startsWith('/api/') || options.json) {
        return res.status(401).json({ error: { message: 'Authentication required.' } });
      }
      if (options.redirect !== false) {
        return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl || req.url));
      }
      return res.status(401).end();
    }
    return next();
  };
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: { message: 'Authentication required.' } });
    if (req.isSuperAdmin || req.permissions.includes('*') || req.permissions.includes(permission)) return next();
    return res.status(403).json({ error: { message: 'Insufficient permissions.' } });
  };
}

function requireAnyPermission(permissions) {
  const set = new Set(permissions);
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: { message: 'Authentication required.' } });
    if (req.isSuperAdmin || req.permissions.includes('*') || req.permissions.some((p) => set.has(p))) return next();
    return res.status(403).json({ error: { message: 'Insufficient permissions.' } });
  };
}

async function audit(db, user, action, entity, entityId, details, req) {
  const userId = user && user.id != null ? user.id : null;
  const userName = user ? (user.name || user.email || 'system') : 'system';
  const ip = req ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '') : '';
  const userAgent = req ? req.headers['user-agent'] || '' : '';
  await db.run(
    `INSERT INTO audit_logs (user_id, user_name, action, entity, entity_id, details, ip, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, userName, action, entity, entityId || null, details == null ? null : JSON.stringify(details), ip, userAgent, new Date().toISOString()],
  );
}

async function recordLogin(db, { userId, email, ip, userAgent, success, failureReason = null }) {
  await db.run(
    `INSERT INTO login_history (user_id, email, ip, user_agent, success, failure_reason, created_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    [userId || null, email || null, ip || null, userAgent || null, success ? 1 : 0, failureReason || null, new Date().toISOString()],
  );
}

async function recordFailedLogin(db, { email, ip, userAgent, reason }) {
  await recordLogin(db, { userId: null, email, ip, userAgent, success: false, failureReason: reason });
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const row = await db.get(
    `SELECT COUNT(*) AS count FROM login_history
     WHERE email = ? AND success = 0 AND deleted = 0 AND created_at >= ?`,
    [email, since],
  );
  return Number(row ? row.count : 0);
}

async function isAccountLocked(db, email, maxAttempts = 5) {
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const row = await db.get(
    `SELECT COUNT(*) AS count FROM login_history
     WHERE email = ? AND success = 0 AND deleted = 0 AND created_at >= ?`,
    [email, since],
  );
  return Number(row ? row.count : 0) >= maxAttempts;
}

async function getLoginHistory(db, { userId, limit = 50, offset = 0 }) {
  const params = [];
  let where = 'WHERE deleted = 0';
  if (userId != null) {
    where += ' AND user_id = ?';
    params.push(userId);
  }
  const rows = await db.all(
    `SELECT id, user_id, email, ip, user_agent, success, failure_reason, created_at
     FROM login_history ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    email: row.email,
    ip: row.ip,
    userAgent: row.user_agent,
    success: Boolean(row.success),
    failureReason: row.failure_reason,
    createdAt: row.created_at,
  }));
}

async function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function createSession(db, { userId, token, ip, userAgent, ttlMs }) {
  const tokenHash = await hashToken(token);
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  await db.run(
    `INSERT INTO user_sessions (user_id, token_hash, expires_at, ip, user_agent, created_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
    [userId, tokenHash, expiresAt, ip || null, userAgent || null, new Date().toISOString()],
  );
}

async function revokeSession(db, token) {
  const tokenHash = await hashToken(token);
  await db.run(
    `UPDATE user_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL AND deleted = 0`,
    [new Date().toISOString(), tokenHash],
  );
}

async function revokeAllUserSessions(db, userId) {
  await db.run(
    `UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND deleted = 0`,
    [new Date().toISOString(), userId],
  );
}

async function isSessionRevoked(db, token) {
  const tokenHash = await hashToken(token);
  const row = await db.get(
    `SELECT revoked_at FROM user_sessions WHERE token_hash = ? AND deleted = 0 ORDER BY created_at DESC LIMIT 1`,
    [tokenHash],
  );
  return Boolean(row && row.revoked_at);
}

async function getActiveSessions(db, userId) {
  const now = new Date().toISOString();
  const rows = await db.all(
    `SELECT id, token_hash, expires_at, ip, user_agent, created_at
     FROM user_sessions
     WHERE user_id = ? AND revoked_at IS NULL AND deleted = 0 AND expires_at > ?
     ORDER BY created_at DESC`,
    [userId, now],
  );
  return rows.map((row) => ({
    id: row.id,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
    ip: row.ip,
    userAgent: row.user_agent,
    createdAt: row.created_at,
  }));
}

function generateResetToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = {
  SESSION_COOKIE,
  hashPassword,
  verifyPassword,
  makeToken,
  verifyToken,
  getToken,
  loadUser,
  userPermissions,
  setSessionCookie,
  clearSessionCookie,
  authMiddleware,
  requireAuth,
  requirePermission,
  requireAnyPermission,
  audit,
  recordLogin,
  recordFailedLogin,
  isAccountLocked,
  getLoginHistory,
  createSession,
  revokeSession,
  revokeAllUserSessions,
  isSessionRevoked,
  getActiveSessions,
  generateResetToken,
};
