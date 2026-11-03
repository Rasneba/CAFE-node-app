const { initDb } = require('../src/db');
const { seedDemoData } = require('../src/seed');
const { seedErpData } = require('../src/seed-erp');
const { createCloudApp } = require('../src/cloud');

let appPromise;

async function getApp() {
  if (!appPromise) {
    appPromise = (async () => {
      const db = await initDb();
      await seedDemoData(db);
      await seedErpData(db);
      return createCloudApp(db);
    })();
  }
  return appPromise;
}

module.exports = async (req, res) => {
  try {
    const app = await getApp();
    return app(req, res);
  } catch (error) {
    console.error(error);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: { message: error.message || 'Cloud app failed to start.' } }));
  }
};
