const { initDb } = require('../src/db');
const { seedDemoData } = require('../src/seed');
const { seedErpData } = require('../src/seed-erp');

async function main() {
  const db = await initDb();
  const result = await seedDemoData(db, { force: process.argv.includes('--force') });
  if (result.seeded) {
    console.log(`Seeded ${result.categories} categories, ${result.items} menu items and ${result.tables} tables.`);
  } else {
    console.log(`Skipped demo seeding: ${result.reason}.`);
  }
  const erp = await seedErpData(db, { force: process.argv.includes('--force') });
  if (erp.seeded) {
    console.log(`Seeded ${erp.roles} roles, ${erp.users} users and ${erp.ingredients} ingredients.`);
  } else {
    console.log(`Skipped ERP seeding: ${erp.reason}.`);
  }
  await db.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
