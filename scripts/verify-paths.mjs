import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const requiredRepoPaths = ['.npmrc', '.runtime', '.artifacts', 'src', 'tests'];
const missing = requiredRepoPaths.filter((item) => !existsSync(resolve(item)));

if (missing.length > 0) {
  console.error(`Missing expected repo-contained paths: ${missing.join(', ')}`);
  process.exit(1);
}

console.log('Repo-contained development paths are present.');
