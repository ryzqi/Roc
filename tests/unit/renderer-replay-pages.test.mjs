import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

test('replay combines bounded IPC pages and propagates failures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roc-replay-'));
  try {
    const outfile = join(dir, 'replay.mjs');
    await build({ entryPoints: ['src/renderer/assistant/session-store.ts'], outfile, bundle: true, format: 'esm', platform: 'node' });
    const { getRunEvents } = await import(outfile);
    const events = Array.from({ length: 1200 }, (_, i) => ({ sequence: i + 1 }));
    const cursors = [];
    const client = { api: { chat: { getRunEvents: async ({ afterSequence, limit }) => {
      cursors.push(afterSequence);
      return { ok: true, data: { runId: 'run', events: events.slice(afterSequence, afterSequence + limit) } };
    } } } };
    assert.deepEqual((await getRunEvents(client, { runId: 'run', afterSequence: 0 })).data.events, events);
    assert.deepEqual(cursors, [0, 500, 1000]);
    client.api.chat.getRunEvents = async () => ({ ok: false, error: { code: 'failed' } });
    assert.equal((await getRunEvents(client, { runId: 'run', afterSequence: 0 })).ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
