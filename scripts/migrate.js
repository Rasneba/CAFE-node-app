const config = require('../src/config');
const { initDb } = require('../src/db');

async function main() {
  const db = await initDb();
  console.log(`Schema ready on ${db.kind}${db.kind === 'postgres' ? ` (${config.databaseUrl.replace(/:\/\/([^:]+):[^@]+@/, '://$1:***@')})` : ` (${config.sqliteFile})`}`);
  await db.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
