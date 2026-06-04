import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogService } from '../../src/main/services/log-service';
import { RocPaths } from '../../src/main/services/paths';

describe('LogService', () => {
  let root: string;
  let paths: RocPaths;
  let logService: LogService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'roc-log-service-'));
    paths = new RocPaths(root);
    paths.ensureTree();
    logService = new LogService(paths);
    logService.initialize();
  });

  afterEach(async () => {
    const maybeClosable = logService as LogService & { close?: () => Promise<void> };
    await maybeClosable.close?.();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('queues appended logs until flush is requested', async () => {
    logService.append({
      level: 'info',
      message: 'Queued log',
      data: { source: 'test' }
    });

    expect(readFileSync(join(paths.logsDir, 'app.jsonl'), 'utf8')).toBe('');

    await logService.flush();

    const lines = readLogLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual(
      expect.objectContaining({
        level: 'info',
        message: 'Queued log',
        data: { source: 'test' }
      })
    );
    expect(lines[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('writes structured timestamp fields while preserving legacy data', async () => {
    logService.append({
      level: 'warn',
      message: 'Legacy compatible structured log',
      data: { source: 'legacy' }
    });

    await logService.flush();

    const lines = readLogLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual(
      expect.objectContaining({
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        level: 'warn',
        message: 'Legacy compatible structured log',
        data: { source: 'legacy' }
      })
    );
  });

  it('provides convenience methods for structured log events', async () => {
    const providerError = new Error('provider failed');
    providerError.stack = 'provider stack';

    logService.info('Critical services initialized.', {
      service: 'app',
      component: 'initializeCritical',
      traceId: 'trace_1',
      metadata: { phase: 'critical' },
      durationMs: 12,
      memoryMb: 64
    });
    logService.debug('Debug details recorded.', {
      service: 'app',
      metadata: { detail: 'debug' }
    });
    logService.error('Provider request failed.', providerError, {
      service: 'provider-runtime',
      runId: 'run_1',
      metadata: { providerId: 'openai' }
    });

    await logService.flush();

    const lines = readLogLines();
    expect(lines).toEqual([
      expect.objectContaining({
        level: 'info',
        message: 'Critical services initialized.',
        service: 'app',
        component: 'initializeCritical',
        traceId: 'trace_1',
        metadata: { phase: 'critical' },
        durationMs: 12,
        memoryMb: 64
      }),
      expect.objectContaining({
        level: 'debug',
        message: 'Debug details recorded.',
        service: 'app',
        metadata: { detail: 'debug' }
      }),
      expect.objectContaining({
        level: 'error',
        message: 'Provider request failed.',
        service: 'provider-runtime',
        runId: 'run_1',
        metadata: { providerId: 'openai' },
        error: {
          code: 'error',
          message: 'provider failed',
          stack: 'provider stack'
        }
      })
    ]);
  });

  it('allows structured error context to override the default error code', async () => {
    const providerError = new Error('provider failed');
    providerError.stack = 'provider stack';

    logService.error('Provider request failed.', providerError, {
      service: 'deep-agent-runtime',
      error: {
        code: 'provider_http_error',
        message: 'Provider 请求失败。',
        category: 'external',
        stack: providerError.stack
      }
    });

    await logService.flush();

    expect(readLogLines()).toEqual([
      expect.objectContaining({
        level: 'error',
        message: 'Provider request failed.',
        service: 'deep-agent-runtime',
        error: {
          code: 'provider_http_error',
          message: 'Provider 请求失败。',
          category: 'external',
          stack: 'provider stack'
        }
      })
    ]);
  });

  it('writes fatal events with default fatal error metadata', async () => {
    const fatalError = new Error('startup failed');
    fatalError.stack = 'startup stack';

    logService.fatal('Critical startup failure.', fatalError, {
      service: 'app',
      component: 'bootstrap',
      metadata: { phase: 'startup' }
    });

    await logService.flush();

    expect(readLogLines()).toEqual([
      expect.objectContaining({
        level: 'fatal',
        message: 'Critical startup failure.',
        service: 'app',
        component: 'bootstrap',
        metadata: { phase: 'startup' },
        error: {
          code: 'fatal',
          message: 'startup failed',
          stack: 'startup stack'
        }
      })
    ]);
  });

  it('flushes queued logs asynchronously after append', async () => {
    logService.append({ level: 'info', message: 'Automatic flush' });

    await waitForLogCount(1);

    expect(readLogLines()).toEqual([
      expect.objectContaining({
        level: 'info',
        message: 'Automatic flush'
      })
    ]);
  });

  it('preserves logs appended before initialization', async () => {
    await logService.close();
    logService = new LogService(paths);

    logService.append({ level: 'info', message: 'Queued before initialize' });
    logService.initialize();
    await logService.flush();

    expect(readLogLines()).toEqual([
      expect.objectContaining({
        level: 'info',
        message: 'Queued before initialize'
      })
    ]);
  });

  it('preserves queued logs when closed', async () => {
    logService.append({ level: 'warn', message: 'Before close' });

    await logService.close();

    expect(readLogLines()).toEqual([
      expect.objectContaining({
        level: 'warn',
        message: 'Before close'
      })
    ]);
  });

  it('does not accept new logs after close', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    logService.append({ level: 'error', message: 'Before close' });
    await logService.close();
    logService.append({ level: 'info', message: 'After close' });
    await logService.flush();

    expect(readLogLines()).toEqual([
      expect.objectContaining({
        level: 'error',
        message: 'Before close'
      })
    ]);
    expect(warn).toHaveBeenCalledWith('[LogService] Attempted to log after close:', 'After close');
  });

  it('drops the oldest queued logs when the queue exceeds its maximum size', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    for (let index = 0; index < 1005; index += 1) {
      logService.append({ level: 'info', message: `Overflow ${index}` });
    }

    await logService.flush();

    const lines = readLogLines();
    expect(lines).toHaveLength(1000);
    expect(lines[0]).toEqual(expect.objectContaining({ message: 'Overflow 5' }));
    expect(lines.at(-1)).toEqual(expect.objectContaining({ message: 'Overflow 1004' }));
    expect(warn).toHaveBeenCalledWith('[LogService] Queue overflow, dropping 1 logs');
  });

  it('keeps every queued log when the queue reaches the maximum size exactly', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    for (let index = 0; index < 1000; index += 1) {
      logService.append({ level: 'info', message: `Exact capacity ${index}` });
    }

    await logService.flush();

    const lines = readLogLines();
    expect(lines).toHaveLength(1000);
    expect(lines[0]).toEqual(expect.objectContaining({ message: 'Exact capacity 0' }));
    expect(lines.at(-1)).toEqual(expect.objectContaining({ message: 'Exact capacity 999' }));
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not duplicate or lose queued logs when flush is requested concurrently', async () => {
    logService.append({ level: 'info', message: 'Concurrent flush A' });
    logService.append({ level: 'info', message: 'Concurrent flush B' });
    logService.append({ level: 'info', message: 'Concurrent flush C' });

    await Promise.all([logService.flush(), logService.flush(), logService.flush()]);

    expect(readLogLines()).toEqual([
      expect.objectContaining({ message: 'Concurrent flush A' }),
      expect.objectContaining({ message: 'Concurrent flush B' }),
      expect.objectContaining({ message: 'Concurrent flush C' })
    ]);
  });

  it('creates an empty app log file during initialization', () => {
    expect(existsSync(join(paths.logsDir, 'app.jsonl'))).toBe(true);
    expect(readFileSync(join(paths.logsDir, 'app.jsonl'), 'utf8')).toBe('');
  });

  it('rotates the app log when the configured size limit is exceeded', async () => {
    await logService.close();
    logService = new LogService(paths, {
      maxFileSizeMb: 0.0008,
      maxFiles: 10,
      compress: false
    });
    logService.initialize();

    for (let index = 0; index < 20; index += 1) {
      logService.append({ level: 'info', message: `Rotate ${index} ${'x'.repeat(80)}` });
    }

    await logService.flush();

    const archiveFiles = readArchiveFileNames();
    expect(archiveFiles.length).toBeGreaterThan(0);
    expect(statSync(join(paths.logsDir, 'app.jsonl')).size).toBeLessThanOrEqual(Math.ceil(0.0008 * 1024 * 1024));
    expect(readAllLogLines()).toHaveLength(20);
  });

  it('compresses rotated app logs when compression is enabled', async () => {
    await logService.close();
    logService = new LogService(paths, {
      maxFileSizeMb: 0.0006,
      maxFiles: 10,
      compress: true
    });
    logService.initialize();

    for (let index = 0; index < 12; index += 1) {
      logService.append({ level: 'info', message: `Compressed rotation ${index} ${'c'.repeat(80)}` });
    }

    await logService.flush();

    const compressedArchives = readCompressedArchiveFileNames();
    expect(compressedArchives.length).toBeGreaterThan(0);
    expect(readArchiveFileNames()).toEqual([]);
    const decompressed = gunzipSync(readFileSync(join(paths.logsDir, compressedArchives[0]!))).toString('utf8');
    expect(decompressed).toContain('Compressed rotation');
  });

  it('keeps only the configured number of rotated app logs', async () => {
    await logService.close();
    logService = new LogService(paths, {
      maxFileSizeMb: 0.0002,
      maxFiles: 3,
      compress: false
    });
    logService.initialize();

    for (let index = 0; index < 30; index += 1) {
      logService.append({ level: 'warn', message: `Archive ${index} ${'y'.repeat(60)}` });
    }

    await logService.flush();

    expect(readArchiveFileNames().length).toBeLessThanOrEqual(3);
  });

  it('removes the oldest archives when rotation names share a timestamp', async () => {
    await logService.close();
    const oldestArchive = 'app.2000-01-01T00-00-00-000Z.jsonl';
    const newerArchive = 'app.2000-01-01T00-00-00-000Z-1.jsonl';
    const newestArchive = 'app.2000-01-01T00-00-00-000Z-2.jsonl';
    writeFileSync(join(paths.logsDir, oldestArchive), '{"message":"oldest"}\n', 'utf8');
    writeFileSync(join(paths.logsDir, newerArchive), '{"message":"newer"}\n', 'utf8');
    writeFileSync(join(paths.logsDir, newestArchive), '{"message":"newest"}\n', 'utf8');
    logService = new LogService(paths, {
      maxFileSizeMb: 0.000001,
      maxFiles: 2,
      compress: false
    });
    logService.initialize();

    logService.append({ level: 'info', message: `Current ${'z'.repeat(80)}` });
    await logService.flush();

    const archiveFiles = readArchiveFileNames();
    expect(archiveFiles).toHaveLength(2);
    expect(archiveFiles).not.toContain(oldestArchive);
    expect(archiveFiles).toContain(newestArchive);
  });

  function readLogLines(): Array<Record<string, unknown>> {
    const content = readFileSync(join(paths.logsDir, 'app.jsonl'), 'utf8').trim();
    if (content.length === 0) {
      return [];
    }
    return content.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  function readAllLogLines(): Array<Record<string, unknown>> {
    const fileNames = ['app.jsonl', ...readArchiveFileNames()];
    return fileNames.flatMap((fileName) => {
      const content = readFileSync(join(paths.logsDir, fileName), 'utf8').trim();
      if (content.length === 0) {
        return [];
      }
      return content.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    });
  }

  function readArchiveFileNames(): string[] {
    return readdirSync(paths.logsDir)
      .filter((fileName) => fileName !== 'app.jsonl' && fileName.startsWith('app.') && fileName.endsWith('.jsonl'))
      .sort();
  }

  function readCompressedArchiveFileNames(): string[] {
    return readdirSync(paths.logsDir)
      .filter((fileName) => fileName !== 'app.jsonl' && fileName.startsWith('app.') && fileName.endsWith('.jsonl.gz'))
      .sort();
  }

  async function waitForLogCount(expectedCount: number): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      if (readLogLines().length === expectedCount) {
        return;
      }
    }
  }
});
