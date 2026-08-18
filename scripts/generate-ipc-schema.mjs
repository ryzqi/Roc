import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
const registryPath = resolve(repoRoot, 'src/shared/ipc-registry.ts');
const generatedPath = resolve(repoRoot, 'src/shared/ipc-generated.ts');
const generatedPreloadPath = resolve(repoRoot, 'src/preload/ipc-api-generated.ts');
const checkOnly = process.argv.includes('--check');

async function readRegistry() {
  const compiled = await build({
    bundle: true,
    entryPoints: [registryPath],
    format: 'esm',
    logLevel: 'silent',
    platform: 'node',
    target: 'node20',
    write: false
  });
  const output = compiled.outputFiles[0];
  if (output === undefined) {
    throw new Error('IPC registry bundle produced no output.');
  }
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(output.text).toString('base64')}`;
  const loaded = await import(moduleUrl);
  const registry = loaded.ipcRegistry;
  validateRegistry(registry);
  return registry;
}

function validateRegistry(registry) {
  if (typeof registry?.version !== 'number') {
    throw new Error('IPC registry version must be a number.');
  }
  for (const section of ['requests', 'events']) {
    if (!Array.isArray(registry[section])) {
      throw new Error(`IPC registry ${section} must be an array.`);
    }
  }

  const keys = new Set();
  const channels = new Set();
  const preloadMethods = new Set();
  for (const entry of [...registry.requests, ...registry.events]) {
    if (typeof entry.key !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/u.test(entry.key)) {
      throw new Error('IPC registry entry key must be a non-empty identifier.');
    }
    if (typeof entry.channel !== 'string' || !entry.channel.startsWith('roc:')) {
      throw new Error(`IPC registry entry ${entry.key} has an invalid channel.`);
    }
    if (typeof entry.domain !== 'string' || !/^[a-z][A-Za-z0-9]*$/u.test(entry.domain)) {
      throw new Error(`IPC registry entry ${entry.key} has an invalid domain.`);
    }
    if (typeof entry.method !== 'string' || !/^[a-z][A-Za-z0-9]*$/u.test(entry.method)) {
      throw new Error(`IPC registry entry ${entry.key} has an invalid method.`);
    }
    const preloadMethod = `${entry.domain}.${entry.method}`;
    if (keys.has(entry.key)) {
      throw new Error(`Duplicate IPC registry key: ${entry.key}`);
    }
    if (channels.has(entry.channel)) {
      throw new Error(`Duplicate IPC channel: ${entry.channel}`);
    }
    if (preloadMethods.has(preloadMethod)) {
      throw new Error(`Duplicate IPC preload method: ${preloadMethod}`);
    }
    keys.add(entry.key);
    channels.add(entry.channel);
    preloadMethods.add(preloadMethod);
  }

  for (const request of registry.requests) {
    if (request.kind !== 'direct' && request.kind !== 'plugin') {
      throw new Error(`IPC request ${request.key} has an invalid kind.`);
    }
    if (request.kind === 'plugin') {
      if (typeof request.capabilityName !== 'string' || request.capabilityName.length === 0) {
        throw new Error(`IPC plugin request ${request.key} has no capability name.`);
      }
      validateInputTransform(request.key, request.inputTransform);
    }
  }
}

function validateInputTransform(key, inputTransform) {
  if (inputTransform === null || typeof inputTransform !== 'object') {
    throw new Error(`IPC plugin request ${key} has no input transform.`);
  }
  if (['none', 'first', 'optional-first'].includes(inputTransform.kind)) {
    return;
  }
  if (inputTransform.kind === 'id' && (inputTransform.key === 'id' || inputTransform.key === 'runId')) {
    return;
  }
  throw new Error(`IPC plugin request ${key} has an invalid input transform.`);
}

function formatArray(name, entries) {
  const body = entries.map((entry) => `  '${entry.key}'`).join(',\n');
  return `export const ${name} = [\n${body}\n] as const;`;
}

function formatDefinition(entry) {
  return `  { key: '${entry.key}', channel: ipcChannels.${entry.key}, domain: '${entry.domain}', method: '${entry.method}', kind: '${entry.kind}' }`;
}

function formatEventDefinition(entry) {
  return `  { key: '${entry.key}', channel: ipcChannels.${entry.key}, domain: '${entry.domain}', method: '${entry.method}' }`;
}

function formatInputTransform(inputTransform) {
  if (inputTransform.kind === 'id') {
    return `{ kind: 'id', key: '${inputTransform.key}' }`;
  }
  return `{ kind: '${inputTransform.kind}' }`;
}

function generateShared(registry) {
  const allEntries = [...registry.requests, ...registry.events];
  const channels = allEntries.map((entry) => `  ${entry.key}: '${entry.channel}'`).join(',\n');
  const requests = registry.requests.map(formatDefinition).join(',\n');
  const events = registry.events.map(formatEventDefinition).join(',\n');
  const pluginMappings = registry.requests
    .filter((entry) => entry.kind === 'plugin')
    .map(
      (entry) =>
        `  { domain: '${entry.domain}', preloadMethod: '${entry.domain}.${entry.method}', channel: ipcChannels.${entry.key}, capabilityName: '${entry.capabilityName}', inputTransform: ${formatInputTransform(entry.inputTransform)} }`
    )
    .join(',\n');
  return `// This file is generated by scripts/generate-ipc-schema.mjs. Do not edit manually.\n\nexport const ipcSchemaVersion = ${registry.version} as const;\n\nexport const ipcChannels = {\n${channels}\n} as const;\n\n${formatArray('ipcRequestChannelKeys', registry.requests)}\n\n${formatArray('ipcEventChannelKeys', registry.events)}\n\nexport const ipcRequestDefinitions = [\n${requests}\n] as const;\n\nexport const ipcEventDefinitions = [\n${events}\n] as const;\n\nexport const pluginCapabilityMappings = [\n${pluginMappings}\n] as const;\n\nexport type IpcChannelKey = keyof typeof ipcChannels;\nexport type IpcRequestChannelKey = (typeof ipcRequestChannelKeys)[number];\nexport type IpcEventChannelKey = (typeof ipcEventChannelKeys)[number];\nexport type GeneratedPluginCapabilityMapping = (typeof pluginCapabilityMappings)[number];\n`;
}

function generatePreload(registry) {
  const domainNames = [];
  for (const entry of [...registry.requests, ...registry.events]) {
    if (!domainNames.includes(entry.domain)) {
      domainNames.push(entry.domain);
    }
  }
  const domains = domainNames.map((domain) => {
    const methods = registry.requests
      .filter((entry) => entry.domain === domain)
      .map(
        (entry) =>
          `    ${entry.method}: (...args) => ipcRenderer.invoke(ipcChannels.${entry.key}, ...args)`
      );
    const subscriptions = registry.events
      .filter((entry) => entry.domain === domain)
      .map(
        (entry) =>
          `    ${entry.method}: (callback) => {\n      const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]) => callback(payload);\n      ipcRenderer.on(ipcChannels.${entry.key}, listener);\n      return () => ipcRenderer.off(ipcChannels.${entry.key}, listener);\n    }`
      );
    return `  ${domain}: {\n${[...methods, ...subscriptions].join(',\n')}\n  }`;
  });
  return `// This file is generated by scripts/generate-ipc-schema.mjs. Do not edit manually.\n\nimport { ipcRenderer } from 'electron';\n\nimport type { RocPreloadApi } from '../shared/ipc-registry';\nimport { ipcChannels } from '../shared/ipc-generated';\n\nexport const rocApi: RocPreloadApi = {\n${domains.join(',\n')}\n};\n`;
}

function writeOrCheck(path, generated) {
  if (checkOnly) {
    const current = readFileSync(path, 'utf8');
    if (current !== generated) {
      throw new Error(`IPC generated file is out of date: ${path}. Run pnpm generate:ipc.`);
    }
    return;
  }
  writeFileSync(path, generated, 'utf8');
}

const registry = await readRegistry();
writeOrCheck(generatedPath, generateShared(registry));
writeOrCheck(generatedPreloadPath, generatePreload(registry));

if (checkOnly) {
  console.log('IPC generated files are current.');
} else {
  console.log(`Generated ${generatedPath}`);
  console.log(`Generated ${generatedPreloadPath}`);
}
