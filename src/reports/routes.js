const express = require('express');
const { parseReportCriteria } = require('./reportCriteria');
const { restaurantSalesCsv } = require('./reportCsv');

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

function createReportsRouter(service, options) {
  const router = express.Router();

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.get('/', (req, res) => {
    res.json({
      group: 'Restaurant Report',
      reports: [{
        id: 'restaurant-sales',
        name: 'Restaurant Sales Report',
        description: 'Sales collections, paid orders, taxes, refunds, expenses and item performance.',
        criteria: ['from', 'to'],
        formats: ['json', 'csv', 'print'],
      }],
    });
  });

  router.get('/restaurant-sales', asyncRoute(async (req, res) => {
    const criteria = parseReportCriteria(req.query, options.timeZone);
    const report = await service.getRestaurantSales(criteria);
    res.json(report);
  }));

  router.get('/restaurant-sales/export', asyncRoute(async (req, res) => {
    const criteria = parseReportCriteria(req.query, options.timeZone);
    const report = await service.getRestaurantSales(criteria);
    const filename = `restaurant-sales-${criteria.from}-to-${criteria.to}.csv`;
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    res.send(restaurantSalesCsv(report));
  }));

  return router;
}

module.exports = { createReportsRouter };
