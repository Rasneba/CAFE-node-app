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
  const token = getToken(req);
  if (token) {
    const payload = verifyToken(token);
    if (payload && payload.sub != null) {
      const user = await db.get('SELECT * FROM users WHERE id = ? AND deleted = 0', [Number(payload.sub)]);
      if (user) {
        user.permissions = await userPermissions(db, user.id);
        return { user, permissions: user.permissions, isSuperAdmin: Boolean(user.is_super_admin), token };
      }
    }
  }

  const basic = basicCredentials(req);
  if (basic) {
    const user = await db.get('SELECT * FROM users WHERE email = ? AND deleted = 0', [basic.username]);
    if (user && verifyPassword(basic.password, user.password_hash)) {
      user.permissions = await userPermissions(db, user.id);
      return { user, permissions: user.permissions, isSuperAdmin: Boolean(user.is_super_admin), token: makeToken(user, user.permissions) };
    }
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

async function userPermissions(db, userId) {
  const rows = await db.all(
    `SELECT p.code
     FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id AND r.is_system = 1
     JOIN role_permissions rp ON rp.role_id = r.id
     JOIN permissions p ON p.code = rp.permission_code
     WHERE ur.user_id = ?`,
    [userId],
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
};
