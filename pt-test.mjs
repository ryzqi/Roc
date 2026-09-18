import { _electron as electron } from '@playwright/test';
const app = await electron.launch({ executablePath: process.argv[2], args: ['/tmp/pt-esm'], timeout: 30000 });
console.log('launched ok');
const w = await app.firstWindow();
console.log('firstWindow ok');
await app.close();
