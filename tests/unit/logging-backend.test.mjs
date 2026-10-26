import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const bundleDirectory = await mkdtemp(join(repositoryRoot, '.roc-logging-bundle-'));
const { LogService } = await importTypeScriptModule('src/main/services/log-service.ts', {
  platform: 'node',
  external: ['pino'],
  tempDir: bundleDirectory
});
const { InfrastructureLogger } = await importTypeScriptModule('src/main/infrastructure/logger.ts', {
  platform: 'node',
  external: ['better-sqlite3', 'pino'],
  tempDir: bundleDirectory
});
const { PinoJsonlBackend } = await importTypeScriptModule('src/main/infrastructure/pino-backend.ts', {
  platform: 'node',
  external: ['pino'],
  tempDir: bundleDirectory
});
await rm(bundleDirectory, { recursive: true, force: true });

async function temporaryRoot() {
  return await mkdtemp(join(tmpdir(), 'roc-logging-'));
}

async function readEvents(directory) {
  const names = await readdir(directory);
  const files = names.filter((name) => name === 'app.jsonl' || /^app\..+\.jsonl(?:\.gz)?$/u.test(name));
  const events = [];
  for (const name of files) {
    const bytes = await readFile(join(directory, name));
    const content = name.endsWith('.gz') ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
    for (const line of content.split('\n').filter(Boolean)) events.push(JSON.parse(line));
  }
  return events;
}

test('application and plugin loggers keep separate JSONL schemas and paths', async () => {
  const root = await temporaryRoot();
  const appLogs = join(root, '.roc', 'logs');
  const pluginLogs = join(root, '.roc', 'plugin-data', 'logs');
  try {
    await mkdir(appLogs, { recursive: true });
    const app = new LogService({ logsDir: appLogs });
    app.initialize();
    app.info('app started', {
      service: 'logging-test',
      component: 'fixture',
      runId: 'run-7',
      metadata: {
        credentials: {
          apiKey: 'sk-app-secret',
          password: 'app-password',
          accessToken: 'app-access-token',
          client_secret: 'app-client-secret',
          privateKey: 'app-private-key'
        }
      }
    });
    app.error('operation failed', new Error('fixture failure'), { service: 'logging-test', runId: 'run-7' });
    await app.close();

    const infrastructure = new InfrastructureLogger(pluginLogs);
    const plugin = infrastructure.createPluginLogger('@roc/plugin-logging-test');
    plugin.info('plugin started', {
      attempt: 1,
      credentials: {
        token: 'plugin-token',
        authorization: 'Bearer plugin-secret',
        accessToken: 'plugin-access-token',
        client_secret: 'plugin-client-secret',
        privateKey: 'plugin-private-key'
      }
    });
    plugin.warn('plugin warning');
    await infrastructure.close();

    const appEvents = await readEvents(appLogs);
    const pluginEvents = await readEvents(pluginLogs);
    assert.deepEqual(appEvents.map(({ level, message }) => ({ level, message })), [
      { level: 'info', message: 'app started' },
      { level: 'error', message: 'operation failed' }
    ]);
    assert.equal(typeof appEvents[0].createdAt, 'string');
    assert.equal(appEvents[0].timestamp, appEvents[0].createdAt);
    assert.equal(appEvents[0].service, 'logging-test');
    assert.equal(appEvents[0].component, 'fixture');
    assert.equal(appEvents[0].runId, 'run-7');
    assert.equal(appEvents[0].pid, undefined);
    assert.equal(appEvents[0].hostname, undefined);
    assert.equal(appEvents[0].time, undefined);
    assert.equal(appEvents[0].msg, undefined);
    assert.deepEqual(appEvents[0].metadata, {
      credentials: {
        apiKey: '[REDACTED]',
        password: '[REDACTED]',
        accessToken: '[REDACTED]',
        client_secret: '[REDACTED]',
        privateKey: '[REDACTED]'
      }
    });
    assert.deepEqual(appEvents[1].error, {
      code: 'error',
      message: 'fixture failure',
      stack: appEvents[1].error.stack
    });
    assert.ok(appEvents[1].error.stack.includes('fixture failure'));
    assert.deepEqual(pluginEvents.map(({ level, pluginId, message, metadata }) => ({ level, pluginId, message, metadata })), [
      {
        level: 'info',
        pluginId: '@roc/plugin-logging-test',
        message: 'plugin started',
        metadata: {
          attempt: 1,
          credentials: {
            token: '[REDACTED]',
            authorization: '[REDACTED]',
            accessToken: '[REDACTED]',
            client_secret: '[REDACTED]',
            privateKey: '[REDACTED]'
          }
        }
      },
      { level: 'warn', pluginId: '@roc/plugin-logging-test', message: 'plugin warning', metadata: undefined }
    ]);
    assert.equal(pluginEvents[0].timestamp, pluginEvents[0].createdAt);
    assert.equal(appLogs, join(root, '.roc', 'logs'));
    assert.equal(pluginLogs, join(root, '.roc', 'plugin-data', 'logs'));

    const query = spawnSync(process.execPath, [join(repositoryRoot, 'scripts/query-logs.mjs'), '--level', 'error', '--runId', 'run-7'], {
      env: { ...process.env, HOME: root },
      encoding: 'utf8'
    });
    assert.equal(query.error, undefined);
    assert.equal(query.status, 0, query.stderr);
    assert.match(query.stdout, /ERROR operation failed/u);
    assert.match(query.stdout, /Error: error - fixture failure/u);
    assert.doesNotMatch(query.stdout, /app started/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('application log rotation compresses archives and retains the configured count', async () => {
  const root = await temporaryRoot();
  const logsDir = join(root, 'logs');
  try {
    await mkdir(logsDir, { recursive: true });
    const logger = new LogService({ logsDir }, { maxFileSizeMb: 0.0001, maxFiles: 2, compress: true });
    logger.initialize();
    for (let index = 0; index < 8; index += 1) {
      logger.info(`rotation-${index}`, { metadata: { payload: 'x'.repeat(256) } });
    }
    await logger.close();

    const files = (await readdir(logsDir)).filter((name) => /^app\..+\.jsonl(?:\.gz)?$/u.test(name));
    assert.equal(files.length, 2);
    assert.ok(files.every((name) => name.endsWith('.gz')));
    const archivedEvents = await readEvents(logsDir);
    assert.ok(archivedEvents.length >= 2);
    assert.ok(archivedEvents.every((event) => event.level === 'info' && event.message.startsWith('rotation-')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('application logger retains concurrent writes during rotation and close flush', async () => {
  const root = await temporaryRoot();
  const logsDir = join(root, 'logs');
  try {
    await mkdir(logsDir, { recursive: true });
    const logger = new LogService({ logsDir }, { maxFileSizeMb: 0.0001, maxFiles: 100, compress: true });
    logger.initialize();
    logger.info('rotation-trigger', { metadata: { payload: 'x'.repeat(1024 * 1024) } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    for (let index = 0; index < 50; index += 1) logger.info(`concurrent-${index}`);
    await logger.close();

    const events = await readEvents(logsDir);
    assert.equal(events.length, 51);
    assert.equal(new Set(events.map((event) => event.message)).size, 51);
    assert.ok(events.some((event) => event.message === 'rotation-trigger'));
    for (let index = 0; index < 50; index += 1) assert.ok(events.some((event) => event.message === `concurrent-${index}`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('application logger bounds its event queue and flushes retained events at shutdown', async () => {
  const root = await temporaryRoot();
  const logsDir = join(root, 'logs');
  const warnings = [];
  const warn = console.warn;
  try {
    await mkdir(logsDir, { recursive: true });
    console.warn = (...args) => warnings.push(args);
    const logger = new LogService({ logsDir });
    logger.initialize();
    for (let index = 0; index < 1100; index += 1) logger.info(`queued-${index}`);
    logger.info('oversized-queue-record', { metadata: { payload: 'x'.repeat(4 * 1024 * 1024) } });
    await logger.close();

    const events = await readEvents(logsDir);
    assert.equal(events.length, 1000);
    assert.equal(events[0].message, 'queued-100');
    assert.equal(events.at(-1).message, 'queued-1099');
    assert.ok(warnings.some(([message]) => /Queue overflow, dropping \d+ logs/u.test(String(message))));
    assert.ok(warnings.some(([message]) => String(message).includes('record exceeds')));
  } finally {
    console.warn = warn;
    await rm(root, { recursive: true, force: true });
  }
});

test('shared Pino backend reports SonicBoom drops and destination errors', async () => {
  const root = await temporaryRoot();
  const warnings = [];
  const errors = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  try {
    await mkdir(root, { recursive: true });
    console.warn = (...args) => warnings.push(args);
    console.error = (...args) => errors.push(args);

    const dropping = new PinoJsonlBackend(join(root, 'drop.jsonl'), { maxBufferedBytes: 64 });
    dropping.write('info', {}, 'oversized-record'.repeat(64));
    await dropping.flush();
    await dropping.close();
    assert.ok(warnings.some(([message]) => String(message).includes('SonicBoom dropped')));

    class FailingDestination extends EventEmitter {
      destroyed = false;
      fd = 1;

      write() {
        queueMicrotask(() => {
          this.destroyed = true;
          this.emit('error', new Error('fixture destination failure'));
        });
      }

      flush(callback) {
        callback?.();
      }

      reopen() {}
      end() {}
    }

    const failing = new PinoJsonlBackend(join(root, 'failure.jsonl'), { destination: new FailingDestination() });
    failing.write('error', {}, 'destination failure');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(errors.some(([message, error]) => String(message).includes('Destination error') && error instanceof Error));
    await failing.close();
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
    await rm(root, { recursive: true, force: true });
  }
});
