import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readWindowPlacementSnapshot, writeWindowPlacementSnapshot } from '../../src/main/window-state-store';

describe('window state store', () => {
  it('round-trips the main window placement snapshot as UTF-8 JSON', () => {
    const root = mkdtempSync(join(tmpdir(), 'roc-window-state-'));
    const filePath = join(root, 'config', 'window-state.json');
    try {
      expect(readWindowPlacementSnapshot(filePath)).toBeNull();

      writeWindowPlacementSnapshot(filePath, {
        bounds: {
          x: 120,
          y: 80,
          width: 1320,
          height: 860
        },
        maximized: true,
        updatedAt: '2026-05-27T00:00:00.000Z'
      });

      expect(readWindowPlacementSnapshot(filePath)).toEqual({
        bounds: {
          x: 120,
          y: 80,
          width: 1320,
          height: 860
        },
        maximized: true,
        updatedAt: '2026-05-27T00:00:00.000Z'
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects malformed placement snapshots instead of partially restoring them', () => {
    const root = mkdtempSync(join(tmpdir(), 'roc-window-state-'));
    const filePath = join(root, 'window-state.json');
    try {
      writeFileSync(
        filePath,
        JSON.stringify({
          bounds: {
            x: 120,
            y: 80,
            width: 0,
            height: 860
          },
          maximized: true,
          updatedAt: '2026-05-27T00:00:00.000Z'
        }),
        'utf8'
      );

      expect(readWindowPlacementSnapshot(filePath)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
