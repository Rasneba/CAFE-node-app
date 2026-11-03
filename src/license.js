const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const config = require('./config');

const PREFIX = 'SKYBLUE_LICENSE_V1';

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function decodeBase64Url(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function machineId() {
  return crypto
    .createHash('sha256')
    .update(`${os.hostname()}|${os.release()}|${os.platform()}|${config.deviceId}`)
    .digest('hex');
}

function signPayload(payload) {
  const signingInput = base64Url(JSON.stringify(payload));
  const signature = crypto
    .createHmac('sha256', config.licenseSecret)
    .update(signingInput)
    .digest('base64url');
  return `${PREFIX}.${signingInput}.${signature}`;
}

function parseKey(key) {
  if (!key || typeof key !== 'string') throw new Error('License key is required.');
  const parts = String(key).split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) throw new Error('Invalid license key format.');
  const payload = JSON.parse(decodeBase64Url(parts[1]));
  const expected = crypto.createHmac('sha256', config.licenseSecret).update(parts[1]).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts[2]))) throw new Error('License key signature is invalid.');
  return payload;
}

function readFileLicense() {
  try {
    return fs.readFileSync(config.licenseFile, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function writeFileLicense(key) {
  fs.mkdirSync(path.dirname(config.licenseFile), { recursive: true });
  fs.writeFileSync(config.licenseFile, key, { encoding: 'utf8' });
}

async function getStoredKey(db) {
  try {
    const row = await db.get('SELECT value FROM sync_state WHERE key = ?', ['license_key']);
    if (row && row.value) return row.value;
  } catch {
    // sync_state may not exist yet.
  }
  return readFileLicense();
}

async function setStoredKey(db, key) {
  try {
    await db.run(
      `INSERT INTO sync_state (key, value) VALUES ('license_key', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [key],
    );
  } catch {
    writeFileLicense(key);
  }
}

async function appendIssuedLicense(db, record) {
  try {
    const row = await db.get('SELECT value FROM sync_state WHERE key = ?', ['issued_licenses']);
    const list = row && row.value ? JSON.parse(row.value) : [];
    list.push(record);
    await db.run(
      `INSERT INTO sync_state (key, value) VALUES ('issued_licenses', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [JSON.stringify(list)],
    );
  } catch {
    // Best effort; issued history is not required for activation.
  }
}

async function activateKey(db, key) {
  const payload = parseKey(key);
  const expiresAt = new Date(payload.expires_at || 0).getTime();
  if (!expiresAt || Date.now() >= expiresAt) throw new Error('License key has expired.');
  if (payload.node && payload.node !== machineId()) {
    throw new Error('License key was issued for another device.');
  }
  await setStoredKey(db, key);
  await appendIssuedLicense(db, {
    key,
    client: payload.client || null,
    tin: payload.tin || null,
    issued_at: payload.issued_at || null,
    expires_at: payload.expires_at || null,
    activated_at: new Date().toISOString(),
    active: true,
  });
  return { active: true, expiresAt: payload.expires_at, issuedTo: payload.client || null };
}

async function issueLicense(db, { client, tin, ttlDays, expiresAt } = {}) {
  const issuedAt = new Date();
  const expiry = expiresAt ? new Date(expiresAt) : new Date(issuedAt.getTime() + Number(ttlDays || 1) * 24 * 60 * 60 * 1000);
  const payload = {
    node: machineId(),
    release: os.release(),
    issued_to: client || 'restaurant',
    client: client || null,
    tin: tin || null,
    issued_at: issuedAt.toISOString(),
    expires_at: expiry.toISOString(),
    version: 1,
  };
  const key = signPayload(payload);
  await setStoredKey(db, key);
  await appendIssuedLicense(db, {
    key,
    client,
    tin,
    issued_at: payload.issued_at,
    expires_at: payload.expires_at,
    activated_at: new Date().toISOString(),
    active: true,
  });
  return { key, active: true, expiresAt: payload.expires_at, issuedTo: client || null };
}

async function status(db) {
  const key = await getStoredKey(db);
  if (!key) return { active: false, reason: 'No license key installed.' };
  try {
    const payload = parseKey(key);
    const expiresAt = new Date(payload.expires_at || 0).getTime();
    const active = Boolean(expiresAt && Date.now() < expiresAt && (!payload.node || payload.node === machineId()));
    return {
      active,
      issuedTo: payload.client || null,
      tin: payload.tin || null,
      issuedAt: payload.issued_at || null,
      expiresAt: payload.expires_at || null,
      remainingSeconds: active ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)) : 0,
      reason: active ? null : 'License is expired or invalid for this device.',
    };
  } catch (error) {
    return { active: false, reason: error.message || 'Invalid license key.' };
  }
}

function requireLicense(options = {}) {
  return (req, res, next) => {
    if (!config.licenseRequired) return next();
    const allow = options.allowPaths || [];
    if (allow.some((p) => req.path === p || req.path.startsWith(p + '/'))) return next();
    if (req.path === '/api/auth/login' || req.path === '/api/auth/logout') return next();
    return res.status(403).json({ error: { message: 'License activation required.' } });
  };
}

module.exports = {
  PREFIX,
  machineId,
  signPayload,
  parseKey,
  issueLicense,
  activateKey,
  status,
  getStoredKey,
  setStoredKey,
  requireLicense,
};
