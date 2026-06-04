import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('query logs scripts', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'roc-query-logs-'));
    mkdirSync(join(root, '.roc', 'logs'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('filters structured JSONL logs with the Node query script', () => {
    writeFileSync(
      join(root, '.roc', 'logs', 'app.jsonl'),
      [
        JSON.stringify({
          timestamp: '2026-06-04T00:00:00.000Z',
          createdAt: '2026-06-04T00:00:00.000Z',
          level: 'info',
          service: 'ipc',
          traceId: 'trace_ipc',
          runId: 'run_ipc',
          message: 'Slow IPC handler recorded.'
        }),
        JSON.stringify({
          timestamp: '2026-06-04T00:01:00.000Z',
          createdAt: '2026-06-04T00:01:00.000Z',
          level: 'error',
          service: 'provider-runtime',
          traceId: 'trace_provider',
          runId: 'run_provider',
          message: 'Provider request failed.',
          error: {
            code: 'error',
            message: 'provider failed'
          }
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('../../scripts/query-logs.mjs', import.meta.url)),
        '--level',
        'error',
        '--service',
        'provider-runtime',
        '--traceId',
        'trace_provider',
        '--runId',
        'run_provider',
        '--since',
        '2026-06-04T00:00:30.000Z',
        '--grep',
        'Provider'
      ],
      {
        cwd: join(root, '.roc'),
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: root,
          USERPROFILE: root
        }
      }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Found 1 matching logs:');
    expect(result.stdout).toContain('[2026-06-04T00:01:00.000Z] ERROR Provider request failed.');
    expect(result.stdout).toContain('Service: provider-runtime');
    expect(result.stdout).toContain('TraceID: trace_provider');
    expect(result.stdout).toContain('Error: error - provider failed');
    expect(result.stdout).not.toContain('Slow IPC handler recorded.');
  });

  it('provides a PowerShell query script with structured filters', () => {
    const script = readFileSync(new URL('../../scripts/query-logs.ps1', import.meta.url), 'utf8');

    expect(script).toContain('[string]$Level');
    expect(script).toContain('[string]$Service');
    expect(script).toContain('[string]$TraceId');
    expect(script).toContain('[string]$RunId');
    expect(script).toContain('[string]$Grep');
    expect(script).toContain('[string]$LogPath');
    expect(script).toContain('ConvertFrom-Json');
  });

  it.runIf(process.platform === 'win32')('filters structured logs with the PowerShell query script', () => {
    writeFileSync(
      join(root, '.roc', 'logs', 'app.jsonl'),
      [
        JSON.stringify({
          timestamp: '2026-06-04T00:00:00.000Z',
          level: 'info',
          service: 'ipc',
          message: 'Slow IPC handler recorded.'
        }),
        JSON.stringify({
          timestamp: '2026-06-04T00:01:00.000Z',
          level: 'error',
          service: 'provider-runtime',
          message: 'Provider request failed.'
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const result = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        fileURLToPath(new URL('../../scripts/query-logs.ps1', import.meta.url)),
        '-Level',
        'error',
        '-Service',
        'provider-runtime',
        '-Grep',
        'Provider',
        '-LogPath',
        join(root, '.roc', 'logs', 'app.jsonl'),
        '-Last',
        '10'
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          USERPROFILE: root
        }
      }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Provider request failed.');
    expect(result.stdout).toContain('provider-runtime');
    expect(result.stdout).not.toContain('Slow IPC handler recorded.');
  });
});
