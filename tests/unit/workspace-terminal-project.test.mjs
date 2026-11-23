import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {mkdtemp, rm, symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import Database from 'better-sqlite3';
import {build} from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'roc-terminal-project-contract-'));
after(() => rm(directory, {recursive: true, force: true}));
await symlink(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir');
await build({stdin: {contents: `
  export {createWorkspacePlugin} from './src/main/plugins/workspace';
  export {ResearchProjectWorkspaceContract} from './src/main/plugins/research/research-project-workspace-contract';
  export {withTerminalOwner} from './src/main/services/terminal-owner-context';
`, resolveDir: process.cwd(), loader: 'ts'}, bundle: true, platform: 'node', format: 'esm', packages: 'external',
outfile: join(directory, 'api.mjs'), logLevel: 'silent', plugins: [{name: 'terminal-process', setup(builder) {
  builder.onResolve({filter: /^node-pty$/}, () => ({path: 'node-pty', namespace: 'terminal-process'}));
  builder.onLoad({filter: /.*/, namespace: 'terminal-process'}, () => ({contents: 'export const spawn = () => globalThis.projectTerminalPty;', loader: 'js'}));
}}]});
const {createWorkspacePlugin, ResearchProjectWorkspaceContract, withTerminalOwner} = await import(pathToFileURL(join(directory, 'api.mjs')).href);

test('workspace terminals read project permissions from research storage and recheck retained sessions', async t => {
  const workspaceDb = new Database(':memory:'), researchDb = new Database(':memory:');
  researchDb.exec('CREATE TABLE research_projects (id TEXT PRIMARY KEY, workspace_path TEXT, status TEXT)');
  const workspacePath = join(directory, 'workspace');
  researchDb.prepare('INSERT INTO research_projects VALUES (?, ?, ?)').run('project', workspacePath, 'active');
  const writes = [];
  globalThis.projectTerminalPty = {resize() {}, kill() {}, pause() {}, resume() {}, onData() {}, onExit() {}, write(data) {writes.push(data);}};
  const handlers = new Map();
  const plugin = createWorkspacePlugin({rootDir: join(directory, 'data'), projectWorkspace: new ResearchProjectWorkspaceContract(researchDb),
    workspaceService: {getCurrentWorkspace: () => null, requireWorkspace: () => ({path: workspacePath}), isPathInsideCurrentWorkspace: path => path === workspacePath}});
  t.after(async () => {await plugin.shutdown(); workspaceDb.close(); researchDb.close(); delete globalThis.projectTerminalPty;});
  await plugin.initialize({database: {getConnection: () => workspaceDb}, logger: {info() {},warn() {},error() {}},
    eventBus: {subscribe: () => () => {}, publish: async () => {}},
    capabilities: {register: (_id, descriptor, handler) => handlers.set(descriptor.name, handler)}});
  const call = (name, input) => withTerminalOwner(31, () => handlers.get(name)(input));
  const request = {projectId: 'project', cwd: workspacePath, cols: 80, rows: 24};
  const attached = await call('terminal.attachSession', request);
  const identity = {projectId: 'project', sessionId: attached.session.id, attachmentId: attached.attachmentId};
  await call('terminal.writeInput', {...identity, data: 'printf ok\r'});
  assert.deepEqual(writes, ['printf ok\r']);
  assert.deepEqual(workspaceDb.prepare("SELECT name FROM sqlite_master WHERE name = 'research_projects'").all(), []);
  for (const [status, path] of [['archived', workspacePath], ['active', '/another-workspace']]) {
    researchDb.prepare('UPDATE research_projects SET status = ?, workspace_path = ? WHERE id = ?').run(status, path, 'project');
    for (const [name, input] of [['terminal.attachSession', request], ['terminal.writeInput', {...identity, data: 'must not execute'}],
      ['terminal.resize', {...identity, cols: 90, rows: 30}]]) {
      await assert.rejects(() => call(name, input), error => error.code === 'terminal_project_workspace_mismatch');
    }
  }
  researchDb.prepare('DELETE FROM research_projects WHERE id = ?').run('project');
  await assert.rejects(() => call('terminal.attachSession', request), error => error.code === 'terminal_project_workspace_mismatch');
  assert.deepEqual(writes, ['printf ok\r']);
  // Cleanup remains possible after archival or deletion.
  await call('terminal.detachSession', identity);
  await call('terminal.closeSession', identity);
});
