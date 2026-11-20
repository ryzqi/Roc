const { app } = require('electron');
const { createRequire } = require('node:module');

const requireBase = process.argv[2];
const moduleSpecifier = process.argv[3] ?? 'better-sqlite3';
const label = process.argv[4] ?? moduleSpecifier;

if (typeof requireBase !== 'string' || requireBase.length === 0) {
  console.error('Missing better-sqlite3 require base.');
  process.exit(1);
}

async function main() {
  await app.whenReady();
  const loadFromBase = createRequire(requireBase);
  const Database = loadFromBase(moduleSpecifier);
  const database = new Database(':memory:');
  try {
    const row = database.prepare('select 1 as value').get();
    if (row.value !== 1) {
      throw new Error(`Unexpected better-sqlite3 probe result for ${label}: ${JSON.stringify(row)}`);
    }
    console.log(`Electron verified ${label} from ${requireBase}.`);
  } finally {
    database.close();
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
