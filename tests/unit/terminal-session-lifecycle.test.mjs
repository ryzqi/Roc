import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Writable} from 'node:stream';
import {setImmediate} from 'node:timers/promises';
import {build} from 'esbuild';

const bundle = await build({
  entryPoints: ['src/main/services/terminal-session-service.ts'],
  bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent',
  plugins: [{name: 'terminal-test-seams', setup(builder) {
    builder.onResolve({filter: /^(node:fs|node-pty)$/}, args => ({path: args.path, namespace: 'terminal-test'}));
    builder.onLoad({filter: /.*/, namespace: 'terminal-test'}, args => ({
      contents: args.path === 'node:fs'
        ? 'export const mkdirSync = () => {}; export const createWriteStream = () => globalThis.terminalTest.stream;'
        : 'export const spawn = () => globalThis.terminalTest.spawn();', loader: 'js'
    }));
  }}]
});
const {TerminalSessionService} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

function fixture(t, failSpawn = false) {
  let completeWrite;
  const stream = new Writable({highWaterMark: 16 * 1024, write(_chunk, _encoding, done) { completeWrite = done; }});
  const pty = {
    paused: false, pauses: 0, resumes: 0, kills: 0,
    pause() { this.paused = true; this.pauses++; },
    resume() { this.paused = false; this.resumes++; },
    kill() { this.kills++; }, write() {}, resize() {},
    onData(callback) { this.data = callback; }, onExit(callback) { this.exit = callback; }
  };
  globalThis.terminalTest = {stream, spawn() {
    if (failSpawn) throw new Error('spawn failed');
    return pty;
  }};
  const service = new TerminalSessionService({terminalDir: '/unused'}, {
    requireWorkspace: () => ({path: '/unused'}), isPathInsideCurrentWorkspace: () => true
  });
  t.after(() => { service.shutdown(); stream.destroy(); delete globalThis.terminalTest; });
  return {stream, pty, service, completeWrite: () => completeWrite()};
}

test('terminal pauses a fast producer until the log drains', async t => {
  const f = fixture(t);
  f.service.createSession({cols: 80, rows: 24});
  const output = [];
  f.service.onOutput(event => output.push(event.data));
  for (let n = 0; n < 256 && !f.pty.paused; n++) f.pty.data('x'.repeat(64 * 1024));
  assert.equal(f.pty.pauses, 1);
  assert.equal(f.stream.writableLength, 64 * 1024);
  assert.equal(output.length, 1);
  f.completeWrite();
  await setImmediate();
  assert.equal(f.pty.resumes, 1);
  f.pty.data('next');
  f.completeWrite();
  assert.equal(output.at(-1), 'next');
});

test('failed spawn destroys the log even though no session was registered', async t => {
  const f = fixture(t, true);
  assert.throws(() => f.service.createSession({cols: 80, rows: 24}), /spawn failed/);
  assert.equal(f.stream.destroyed, true);
  // An asynchronous open failure must have an error listener even on this path.
  assert.doesNotThrow(() => f.stream.emit('error', new Error('open failed')));
});

for (const failure of ['error', 'close']) {
  test(`log ${failure} releases a paused terminal and stops further log writes`, async t => {
    const f = fixture(t);
    f.service.createSession({cols: 80, rows: 24});
    f.pty.data('x'.repeat(64 * 1024));
    f.stream.destroy(failure === 'error' ? new Error('disk failed') : undefined);
    await setImmediate();
    assert.equal(f.pty.pauses, 1);
    assert.equal(f.pty.resumes, 1);
    const output = [];
    f.service.onOutput(event => output.push(event.data));
    const write = t.mock.method(f.stream, 'write');
    f.pty.data('still interactive');
    assert.deepEqual(output, ['still interactive']);
    assert.equal(write.mock.callCount(), 0);
    f.completeWrite(); // Settle the in-flight fake disk write after destruction.
    await setImmediate();
    assert.equal(f.stream.writableLength, 0);
  });
}

for (const close of ['closeSession', 'shutdown', 'exit']) {
  test(`${close} prevents a late drain from resuming the terminal`, t => {
    const f = fixture(t);
    const session = f.service.createSession({cols: 80, rows: 24});
    f.pty.data('x'.repeat(64 * 1024));
    if (close === 'exit') f.pty.exit({exitCode: 0});
    else if (close === 'shutdown') f.service.shutdown();
    else f.service.closeSession({sessionId: session.id});
    f.stream.emit('drain');
    assert.equal(f.pty.resumes, 0);
    assert.equal(f.stream.writableEnded, true);
  });
}
