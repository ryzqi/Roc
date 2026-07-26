import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfigFromFile } from 'vite';

export const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

export async function readPackageJson(): Promise<Record<string, unknown>> {
  const content = await readFile(new URL('../../package.json', import.meta.url), 'utf8');
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed)) {
    throw new Error('package_json_invalid');
  }
  return parsed;
}

export async function loadVitestTestConfig(fileName: string) {
  const config = await loadConfigFromFile(
    { command: 'serve', mode: 'test' },
    resolve(repositoryRoot, fileName)
  );
  if (config === null) {
    throw new Error(`vitest_config_missing:${fileName}`);
  }
  if (config.config.test === undefined) {
    throw new Error(`vitest_test_config_missing:${fileName}`);
  }
  return config.config.test;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
