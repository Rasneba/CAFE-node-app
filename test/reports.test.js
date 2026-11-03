const test = require('node:test');
const assert = require('node:assert/strict');
const { parseReportCriteria } = require('../src/reports/reportCriteria');
const { createDemoReportRepository } = require('../src/reports/demoReportRepository');
const { restaurantSalesCsv, cell } = require('../src/reports/reportCsv');
const { startOfMonth, todayInTimeZone } = require('../src/reports/dateUtils');

const timeZone = 'Africa/Addis_Ababa';
const today = todayInTimeZone(timeZone);

test('parseReportCriteria defaults to the current month', () => {
  const criteria = parseReportCriteria({}, timeZone);
  assert.equal(criteria.from, startOfMonth(today));
  assert.equal(criteria.to, today);
  assert.ok(criteria.days >= 1);
});

test('parseReportCriteria rejects reversed and oversized ranges', () => {
  assert.throws(
    () => parseReportCriteria({ from: '2026-05-10', to: '2026-05-01' }, timeZone),
    /start date/,
  );
  assert.throws(
    () => parseReportCriteria({ from: '2024-01-01', to: '2026-01-01' }, timeZone),
    /366 days/,
  );
});

test('demo report returns totals and a CSV export', async () => {
  const criteria = parseReportCriteria({ from: startOfMonth(today), to: today }, timeZone);
  const repository = createDemoReportRepository({ timeZone, currency: 'ETB' });
  const report = await repository.getRestaurantSales(criteria);

  assert.equal(report.meta.reportType, 'restaurant-sales');
  assert.ok(report.summary.orders > 0);
  assert.ok(Array.isArray(report.daily));
  assert.ok(Array.isArray(report.orders));

  const csv = restaurantSalesCsv(report);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.match(csv, /Restaurant Sales Report/);
  assert.match(csv, /SUMMARY/);
});

test('CSV cells neutralise spreadsheet formulas', () => {
  assert.equal(cell('=1+1'), "'=1+1");
  assert.equal(cell('@cmd'), "'@cmd");
  assert.equal(cell('plain'), 'plain');
});
