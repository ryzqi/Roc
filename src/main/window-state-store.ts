import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { WindowBoundsSnapshot } from '../shared/types';

export type WindowPlacementSnapshot = {
  bounds: WindowBoundsSnapshot;
  maximized: boolean;
  updatedAt: string;
};

export function readWindowPlacementSnapshot(filePath: string): WindowPlacementSnapshot | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (!isWindowPlacementSnapshot(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeWindowPlacementSnapshot(filePath: string, snapshot: WindowPlacementSnapshot): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

function isWindowPlacementSnapshot(value: unknown): value is WindowPlacementSnapshot {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    isWindowBoundsSnapshot(record.bounds) &&
    typeof record.maximized === 'boolean' &&
    typeof record.updatedAt === 'string' &&
    record.updatedAt.length > 0
  );
}

function isWindowBoundsSnapshot(value: unknown): value is WindowBoundsSnapshot {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    isFiniteNumber(record.x) &&
    isFiniteNumber(record.y) &&
    isPositiveFiniteNumber(record.width) &&
    isPositiveFiniteNumber(record.height)
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}
