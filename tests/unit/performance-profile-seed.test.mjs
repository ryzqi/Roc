import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';

test('seeded performance histories accept contiguous production event appends at every scale', async () => {
  mkdirSync(resolve('.runtime'), {recursive: true});
  const root = mkdtempSync(resolve('.runtime/performance-profile-test-'));
  let pool;
  try {
    const bundle = join(root, 'api.mjs');
    await build({stdin: {contents: `
      export {seedUiPerformanceProfile, seedPerformanceProfiles} from './tests/smoke/lib/performance-profile-seed.ts';
      export {DatabasePool} from './src/main/infrastructure/database-pool.ts';
      export {AgentSessionRepository} from './src/main/plugins/agent/session-repository.ts';
    `, resolveDir: process.cwd(), loader: 'ts'}, bundle: true, packages: 'external',
    platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent'});
    const api = await import(pathToFileURL(bundle).href);
    const profiles = {empty: join(root, 'empty'), profile1000: join(root, '1000'), profile10000: join(root, '10000')};
    api.seedPerformanceProfiles(profiles);
    const uiRoot = join(root, 'ui');
    api.seedUiPerformanceProfile(uiRoot);

    for (const [dataRoot, counts] of [[profiles.profile1000, [1000]], [profiles.profile10000, [10000]], [uiRoot, [500, 5000]]]) {
      pool = new api.DatabasePool(join(dataRoot, 'plugin-data'));
      const db = pool.getConnection('@roc/plugin-agent');
      const repository = new api.AgentSessionRepository(db);
      for (const count of counts) {
        const threadId = `thread-profile-${count}`;
        assert.equal(db.prepare('SELECT COUNT(*) FROM agent_events WHERE thread_id = ?').pluck().get(threadId), count);
        // Exercise the same append/cursor path that a real startRun uses. Merely
        // counting seeded rows misses duplicate sequence failures on the next send.
        for (let offset = 1; offset <= 2; offset++) {
          const event = repository.recordEvent({threadId, runId: `run-${threadId}-${count}`,
            type: 'message', payload: {role: 'user', content: `append probe ${offset}`}});
          assert.equal(db.prepare('SELECT sequence FROM agent_events WHERE id = ?').pluck().get(event.id), count + offset);
        }
        assert.equal(db.prepare('SELECT next_sequence FROM agent_thread_event_cursors WHERE thread_id = ?').pluck().get(threadId), count + 3);
      }
      pool.closeAll();
      pool = null;
    }
  } finally {
    pool?.closeAll();
    rmSync(root, {recursive: true, force: true});
  }
});
