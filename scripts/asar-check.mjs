import { readFileSync } from 'node:fs';

const asarPath = process.argv[2];
const buffer = readFileSync(asarPath);
const headerSize = buffer.readUInt32LE(4);
const json = buffer.subarray(8, 8 + headerSize).toString('utf8').replace(/\0+$/, '');
const tree = JSON.parse(json);
const packages = tree.files.node_modules.files;
const names = Object.keys(packages).filter((name) => name.includes('sqlite'));
for (const name of names) {
  const entry = packages[name];
  console.log(name, 'unpacked=' + (entry.unpacked ?? false), 'files=' + JSON.stringify(entry.files ? Object.keys(entry.files) : null));
}
