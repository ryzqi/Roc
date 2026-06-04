import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('creates an empty app log file during initialization', () => {
    expect(existsSync(join(paths.logsDir, 'app.jsonl'))).toBe(true);
    expect(readFileSync(join(paths.logsDir, 'app.jsonl'), 'utf8')).toBe('');
  });

  function readLogLines(): Array<Record<string, unknown>> {
    const content = readFileSync(join(paths.logsDir, 'app.jsonl'), 'utf8').trim();
    if (content.length === 0) {
      return [];
    }
    return content.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
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
