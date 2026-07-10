import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { acquireDatabaseMaintenanceLease } from '../../../src/main/infrastructure/database-maintenance-lease';

const leaseFileName = '.database-maintenance.lock';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-database-maintenance-lease-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('acquireDatabaseMaintenanceLease', () => {
  it('acquires exclusively, blocks a live owner, and removes only its own lease on release', () => {
    const lease = acquireDatabaseMaintenanceLease({
      rootDir: root,
      owner: { kind: 'app', pid: 100 },
      isProcessAlive: () => false
    });

    expect(readLease()).toMatchObject({ kind: 'app', pid: 100 });
    expect(() =>
      acquireDatabaseMaintenanceLease({
        rootDir: root,
        owner: { kind: 'cli', pid: 200 },
        isProcessAlive: () => true
      })
    ).toThrow('database_maintenance_locked');

    lease.release();
    expect(existsSync(leasePath())).toBe(false);
  });

  it('removes a provably stale owner and retries acquisition once', () => {
    writeLease({
      kind: 'app',
      pid: 100,
      token: 'stale-token',
      acquiredAt: '2026-07-09T00:00:00.000Z'
    });
    const isProcessAlive = vi.fn(() => false);

    const lease = acquireDatabaseMaintenanceLease({
      rootDir: root,
      owner: { kind: 'cli', pid: 200 },
      isProcessAlive
    });

    expect(isProcessAlive).toHaveBeenCalledTimes(1);
    expect(readLease()).toMatchObject({ kind: 'cli', pid: 200 });
    expect(readLease().token).not.toBe('stale-token');
    lease.release();
  });

  it('keeps malformed leases and reports an unknown owner', () => {
    writeFileSync(leasePath(), '{invalid-json', 'utf8');

    expect(() =>
      acquireDatabaseMaintenanceLease({
        rootDir: root,
        owner: { kind: 'cli', pid: 200 },
        isProcessAlive: () => false
      })
    ).toThrow('database_maintenance_owner_unknown');
    expect(readFileSync(leasePath(), 'utf8')).toBe('{invalid-json');
  });

  it('keeps the lease when process liveness cannot be proven', () => {
    writeLease({
      kind: 'app',
      pid: 100,
      token: 'unknown-token',
      acquiredAt: '2026-07-09T00:00:00.000Z'
    });

    expect(() =>
      acquireDatabaseMaintenanceLease({
        rootDir: root,
        owner: { kind: 'cli', pid: 200 },
        isProcessAlive: () => {
          throw new Error('access_denied');
        }
      })
    ).toThrow('database_maintenance_owner_unknown');
    expect(readLease().token).toBe('unknown-token');
  });

  it('refuses to delete a lease whose token was replaced', () => {
    const lease = acquireDatabaseMaintenanceLease({
      rootDir: root,
      owner: { kind: 'app', pid: 100 },
      isProcessAlive: () => false
    });
    writeLease({
      kind: 'cli',
      pid: 200,
      token: 'replacement-token',
      acquiredAt: '2026-07-10T00:00:00.000Z'
    });

    expect(() => lease.release()).toThrow('database_maintenance_lease_replaced');
    expect(readLease().token).toBe('replacement-token');
  });
});

function leasePath(): string {
  return join(root, leaseFileName);
}

function readLease(): { kind: 'app' | 'cli'; pid: number; token: string; acquiredAt: string } {
  return JSON.parse(readFileSync(leasePath(), 'utf8')) as {
    kind: 'app' | 'cli';
    pid: number;
    token: string;
    acquiredAt: string;
  };
}

function writeLease(lease: { kind: 'app' | 'cli'; pid: number; token: string; acquiredAt: string }): void {
  writeFileSync(leasePath(), `${JSON.stringify(lease)}\n`, 'utf8');
}
