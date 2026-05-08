import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

export const projectRoot = resolve(scriptDirectory, '..', '..');
export const packageJsonPath = resolve(projectRoot, 'package.json');

export function getElectronVersion() {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const electronVersion = packageJson.devDependencies?.electron;
  if (typeof electronVersion !== 'string' || electronVersion.length === 0) {
    throw new Error(`Missing devDependencies.electron in ${packageJsonPath}.`);
  }
  return electronVersion;
}
