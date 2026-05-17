const asar = require(require.resolve('@electron/asar', { paths: ['node_modules/.pnpm'] }));
asar.extractAll('release/win-unpacked/resources/app.asar', 'tmp-asar-dump');
console.log('done');
