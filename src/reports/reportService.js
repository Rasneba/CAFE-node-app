const postgresRepository = require('./postgresReportRepository');
const { createDemoReportRepository } = require('./demoReportRepository');
const { createSqliteReportRepository } = require('./sqliteReportRepository');

function createReportService(options) {
  let repository;
  let mode;
  if (options.databaseUrl) {
    repository = postgresRepository;
    mode = 'postgresql';
  } else if (options.useDemo === true) {
    repository = createDemoReportRepository(options);
    mode = 'demo';
  } else {
    repository = createSqliteReportRepository(options);
    mode = 'sqlite';
  }

  return {
    mode,
    getRestaurantSales(criteria) {
      return repository.getRestaurantSales(criteria, options);
    },
  };
}

module.exports = { createReportService };
