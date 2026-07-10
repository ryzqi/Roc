import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';

const leaseFileName = '.database-maintenance.lock';

export type DatabaseMaintenanceLeaseOwner = {
  kind: 'app' | 'cli';
  pid: number;
};

export type DatabaseMaintenanceLease = {
  release(): void;
};

type DatabaseMaintenanceLeaseRecord = DatabaseMaintenanceLeaseOwner & {
  token: string;
  acquiredAt: string;
};

type DatabaseMaintenanceLeaseInput = {
  rootDir: string;
  owner: DatabaseMaintenanceLeaseOwner;
  isProcessAlive?: (pid: number) => boolean;
};

export function acquireDatabaseMaintenanceLease(input: DatabaseMaintenanceLeaseInput): DatabaseMaintenanceLease {
  mkdirSync(input.rootDir, { recursive: true });
  return acquireWithAtMostOneStaleRetry(input, 0);
}

function acquireWithAtMostOneStaleRetry(
  input: DatabaseMaintenanceLeaseInput,
  staleRetryCount: number
): DatabaseMaintenanceLease {
  const path = join(input.rootDir, leaseFileName);
  const token = randomUUID();
  const record: DatabaseMaintenanceLeaseRecord = {
    ...input.owner,
    token,
    acquiredAt: new Date().toISOString()
  };
  let fileDescriptor: number;
  try {
    fileDescriptor = openSync(path, 'wx');
  } catch (error) {
    if (!isNodeErrorCode(error, 'EEXIST')) {
      throw error;
    }
    return handleExistingLease(input, staleRetryCount, path);
  }

  let writeFailed = false;
  let writeError: unknown;
  try {
    writeFileSync(fileDescriptor, `${JSON.stringify(record)}\n`, 'utf8');
    fsyncSync(fileDescriptor);
  } catch (error) {
    writeFailed = true;
    writeError = error;
  } finally {
    closeSync(fileDescriptor);
  }
  if (writeFailed) {
    rmSync(path, { force: true });
    throw writeError;
  }

  let released = false;
  return {
    release(): void {
      if (released) {
        return;
      }
      let current: DatabaseMaintenanceLeaseRecord;
      try {
        current = readLeaseRecord(path);
      } catch {
        throw new Error('database_maintenance_lease_replaced');
      }
      if (current.token !== token) {
        throw new Error('database_maintenance_lease_replaced');
      }
      rmSync(path);
      released = true;
    }
  };
}

function handleExistingLease(
  input: DatabaseMaintenanceLeaseInput,
  staleRetryCount: number,
  path: string
): DatabaseMaintenanceLease {
  const existing = readLeaseRecord(path);
  const processAlive = input.isProcessAlive === undefined ? isProcessAlive : input.isProcessAlive;
  let alive: boolean;
  try {
    alive = processAlive(existing.pid);
  } catch {
    throw new Error('database_maintenance_owner_unknown');
  }
  if (alive) {
    throw new Error('database_maintenance_locked');
  }
  if (staleRetryCount >= 1) {
    throw new Error('database_maintenance_locked');
  }
  rmSync(path);
  return acquireWithAtMostOneStaleRetry(input, staleRetryCount + 1);
}

function readLeaseRecord(path: string): DatabaseMaintenanceLeaseRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    throw new Error('database_maintenance_owner_unknown');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('database_maintenance_owner_unknown');
  }
  const record = parsed as Record<string, unknown>;
  if (record.kind !== 'app' && record.kind !== 'cli') {
    throw new Error('database_maintenance_owner_unknown');
  }
  if (!Number.isInteger(record.pid) || typeof record.pid !== 'number' || record.pid <= 0) {
    throw new Error('database_maintenance_owner_unknown');
  }
  if (typeof record.token !== 'string' || record.token.length === 0 || typeof record.acquiredAt !== 'string') {
    throw new Error('database_maintenance_owner_unknown');
  }
  return {
    kind: record.kind,
    pid: record.pid,
    token: record.token,
    acquiredAt: record.acquiredAt
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeErrorCode(error, 'ESRCH')) {
      return false;
    }
    throw new Error('database_maintenance_owner_unknown');
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && Reflect.get(error, 'code') === code;
}
