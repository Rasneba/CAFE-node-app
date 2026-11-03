const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(root, '.env') });

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

const fileConfig = readJson(path.join(root, 'config.json'));
const env = process.env;

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const mode = String(env.MODE || fileConfig.mode || (env.VERCEL ? 'cloud' : 'local')).toLowerCase();
const printer = {
  name: env.PRINTER_NAME || fileConfig.printer?.name || 'Kitchen pass',
  ip: env.PRINTER_IP || fileConfig.printer?.ip || '192.168.1.50',
  port: num(env.PRINTER_PORT || fileConfig.printer?.port, 9100),
  paperWidth: num(env.PRINTER_PAPER_WIDTH || fileConfig.printer?.paperWidth, 80),
  encoding: env.PRINTER_ENCODING || fileConfig.printer?.encoding || 'ascii',
  dryRun: bool(env.PRINT_DRY_RUN, fileConfig.printer?.dryRun ?? true),
};

const adminUsername = env.ADMIN_USERNAME || fileConfig.adminUsername || 'manager';
const adminPassword = env.ADMIN_PASSWORD || fileConfig.adminPassword || '';
const sessionSecret = env.SESSION_SECRET
  || fileConfig.sessionSecret
  || crypto.createHash('sha256').update(`${adminUsername}:${adminPassword}:${env.DEVICE_API_KEY || ''}:restaurant-erp`).digest('hex');

const config = {
  root,
  mode,
  port: num(env.PORT || fileConfig.port, mode === 'cloud' ? 3000 : 4100),
  databaseUrl: String(env.DATABASE_URL || fileConfig.databaseUrl || '').trim(),
  sqliteFile: path.resolve(root, env.SQLITE_FILE || fileConfig.sqliteFile || 'data/local.db'),
  deviceId: env.DEVICE_ID || fileConfig.deviceId || 'restaurant-main',
  deviceApiKey: env.DEVICE_API_KEY || fileConfig.deviceApiKey || '',
  cloudUrl: String(env.CLOUD_URL || fileConfig.cloudUrl || '').replace(/\/+$/, ''),
  syncIntervalMs: num(env.SYNC_INTERVAL_MS || fileConfig.syncIntervalMs, 180000),
  printer,
  restaurantName: env.RESTAURANT_NAME || fileConfig.restaurantName || 'Maison Addis',
  currency: String(env.CURRENCY || fileConfig.currency || 'ETB').toUpperCase(),
  taxRate: num(env.TAX_RATE || fileConfig.taxRate, 15),
  serviceChargeRate: num(env.SERVICE_CHARGE_RATE || fileConfig.serviceChargeRate, 10),
  timeZone: env.APP_TIMEZONE || fileConfig.timeZone || 'Africa/Addis_Ababa',
  publicUrl: String(env.PUBLIC_URL || fileConfig.publicUrl || '').replace(/\/+$/, ''),
  adminUsername,
  adminPassword,
  sessionSecret,
  sessionTtlMs: num(env.SESSION_TTL_MS || fileConfig.sessionTtlMs, 12 * 60 * 60 * 1000),
  licenseRequired: bool(env.LICENSE_REQUIRED, fileConfig.licenseRequired ?? false),
  licenseSecret: env.LICENSE_SECRET || fileConfig.licenseSecret || sessionSecret,
  licenseFile: path.resolve(root, env.LICENSE_FILE || fileConfig.licenseFile || '_storage/license.dat'),
  issuedLicensesFile: path.resolve(root, env.ISSUED_LICENSES_FILE || fileConfig.issuedLicensesFile || '_storage/issued-licenses.json'),
  superAdminEmail: String(env.SUPER_ADMIN_EMAIL || fileConfig.superAdminEmail || 'owner@genius.et').toLowerCase(),
  isCloud: mode === 'cloud' || Boolean(env.VERCEL),
};

new Intl.DateTimeFormat('en-US', { timeZone: config.timeZone }).format(new Date());

module.exports = config;
