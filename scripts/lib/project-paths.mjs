import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

export const projectRoot = resolve(scriptDirectory, '..', '..');
export const packageJsonPath = resolve(projectRoot, 'package.json');
