import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Database from 'better-sqlite3';

test('event log preserves exact retention, rollback recovery, sparse restore and replay pages', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roc-event-log-'));
  const db = new Database(':memory:');
  try {
    const outfile = join(dir, 'log.mjs');
    await build({ entryPoints: ['src/main/plugins/agent/run-event-log.ts'], outfile, bundle: true, format: 'esm', platform: 'node' });
    const { AgentRunEventLog } = await import(outfile);
    db.exec(`CREATE TABLE agent_run_events(run_id TEXT, sequence INTEGER, event_json TEXT, created_at TEXT, PRIMARY KEY(run_id, sequence));
      CREATE TABLE agent_run_event_cursors(run_id TEXT PRIMARY KEY, next_sequence INTEGER);`);
    const log = new AgentRunEventLog(db);
    const event = { type: 'assistant_block', runId: 'run', block: { kind: 'text', blockId: 'text', phase: 'delta', text: 'x' } };
    const rollback = db.transaction(() => { log.recordRunEvent(event); throw new Error('rollback'); });
    assert.throws(rollback, /rollback/);
    assert.equal(log.recordRunEvent(event).sequence, 1);
    for (let i = 0; i < 10010; i++) log.recordRunEvent(event);
    const all = log.listRunEvents({ runId: 'run', afterSequence: 0 });
    assert.equal(all.length, 10000);
    assert.equal(all[0].sequence, 12);
    const pages = [];
    let cursor = 0;
    while (true) {
      const page = log.listRunEvents({ runId: 'run', afterSequence: cursor, limit: 500 });
      pages.push(...page);
      if (page.length < 500) break;
      cursor = page.at(-1).sequence;
    }
    assert.deepEqual(pages, all);
    log.restoreRunEvent({ runId: 'sparse', sequence: 20000, eventJson: JSON.stringify({ ...event, runId: 'sparse' }), createdAt: 'now' });
    assert.equal(log.recordRunEvent({ ...event, runId: 'sparse' }).sequence, 20001);
    assert.equal(log.listRunEvents({ runId: 'sparse', afterSequence: 0 }).length, 2);
    log.deleteForRunIds(['run']);
    assert.equal(log.recordRunEvent(event).sequence, 1);
    assert.equal(log.listRunEvents({ runId: 'run', afterSequence: 0 }).length, 1);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
