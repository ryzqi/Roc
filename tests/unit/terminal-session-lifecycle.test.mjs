import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Writable} from 'node:stream';
import {setImmediate} from 'node:timers/promises';
import {build} from 'esbuild';

const bundle = await build({
  stdin: {contents: `export {TerminalSessionService, TERMINAL_REPLAY_LIMIT} from './src/main/services/terminal-session-service';
    export {withTerminalOwner} from './src/main/services/terminal-owner-context';
    export {TerminalOutputCursor} from './src/renderer/canvas/terminal/terminal-output-cursor';
    export {createTerminalOutputBatcher} from './src/main/terminal-output-batcher';`, resolveDir: process.cwd(), loader: 'ts'},
  bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent',
  plugins: [{name: 'terminal-test-seams', setup(builder) {
    builder.onResolve({filter: /^(node:fs|node-pty)$/}, args => ({path: args.path, namespace: 'terminal-test'}));
    builder.onLoad({filter: /.*/, namespace: 'terminal-test'}, args => ({
      contents: args.path === 'node:fs'
        ? 'export const mkdirSync = () => {}; export const createWriteStream = () => globalThis.terminalTest.createStream();'
        : 'export const spawn = () => globalThis.terminalTest.spawn();', loader: 'js'
    }));
  }}]
});
const {TerminalSessionService, TERMINAL_REPLAY_LIMIT, withTerminalOwner, TerminalOutputCursor, createTerminalOutputBatcher} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

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
  const streams = [];
  const workspace = {path: '/unused'};
  globalThis.terminalTest = {createStream() {
    const next = streams.length === 0 ? stream : new Writable({write(_chunk,_encoding,done) {done();}});
    streams.push(next);return next;
  }, spawn() {
    if (failSpawn) throw new Error('spawn failed');
    return pty;
  }};
  const service = new TerminalSessionService({terminalDir: '/unused'}, {
    requireWorkspace: () => workspace, isPathInsideCurrentWorkspace: path => path === workspace.path
  });
  t.after(() => { service.shutdown(); for(const item of streams)item.destroy(); stream.destroy(); delete globalThis.terminalTest; });
  return {stream, pty, service, workspace, completeWrite: () => completeWrite()};
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

const attachRequest = {projectId: 'project-a', cols: 80, rows: 24};
const identity = attachment => ({sessionId: attachment.session.id, attachmentId: attachment.attachmentId, projectId: 'project-a'});

test('hidden display detaches without killing and restores all retained output on the same PTY', t => {
  const f = fixture(t), output = [];
  f.service.onOutput(event => output.push(event));
  const first = f.service.attachSession(attachRequest);
  f.pty.data('before\r\n');
  f.service.detachSession(identity(first));
  f.pty.data('during\r\n');
  assert.equal(output.length, 1);
  assert.equal(f.pty.kills, 0);
  const second = f.service.attachSession(attachRequest);
  assert.equal(second.session.id, first.session.id);
  assert.notEqual(second.attachmentId, first.attachmentId);
  assert.equal(second.replay.data, 'before\r\nduring\r\n');
  assert.equal(second.replay.sequence, second.replay.data.length);
  f.pty.data('after');
  assert.equal(output.at(-1).startSequence, second.replay.sequence);
  assert.equal(output.at(-1).attachmentId, second.attachmentId);
});

test('late detach cannot disconnect a replacement and stale lease cannot write resize or close', t => {
  const f = fixture(t);
  const first = f.service.attachSession(attachRequest), second = f.service.attachSession(attachRequest);
  f.service.detachSession(identity(first));
  assert.deepEqual(f.service.writeInput({...identity(second), data: 'pwd\r'}), {delivered: true});
  for (const [method, extra] of [['writeInput', {data:'bad'}], ['resize', {cols:80,rows:24}], ['closeSession', {}]]) {
    assert.throws(() => f.service[method]({...identity(first), ...extra}), error => error.code === 'terminal_session_scope_mismatch');
  }
  assert.equal(f.pty.kills, 0);
  f.service.closeSession(identity(second));
  assert.equal(f.pty.kills, 1);
});

test('sender project and current workspace isolate every active session operation', t => {
  const f = fixture(t);
  const first = withTerminalOwner(11, () => f.service.attachSession(attachRequest));
  const output = [];f.service.onOutput(event => output.push(event));f.pty.data('owned');
  assert.equal(output[0].ownerId,11);
  assert.throws(() => withTerminalOwner(12, () => f.service.attachSession({...attachRequest, sessionId:first.session.id})), error => error.code === 'terminal_session_scope_mismatch');
  assert.throws(() => withTerminalOwner(11, () => f.service.writeInput({...identity(first), projectId:'other', data:'pwd'})), error => error.code === 'terminal_session_scope_mismatch');
  f.workspace.path = '/new-project';
  assert.throws(() => withTerminalOwner(11, () => f.service.writeInput({...identity(first), data:'pwd'})), error => error.code === 'terminal_session_scope_mismatch');
  // Old cleanup still detaches safely after the shell has selected another project.
  withTerminalOwner(11, () => f.service.detachSession(identity(first)));
  f.service.closeOwner(12);
  assert.equal(f.pty.kills, 0);
  f.service.closeOwner(11);
  assert.equal(f.pty.kills, 1);
});

test('exit while detached is replayable and owner shutdown releases every retained identity', t => {
  const f = fixture(t);
  const first = f.service.attachSession(attachRequest);
  f.service.detachSession(identity(first));
  f.pty.data('finished\r\n');
  f.pty.exit({exitCode:7});
  const resumed = f.service.attachSession(attachRequest);
  assert.equal(resumed.session.id, first.session.id);
  assert.equal(resumed.session.status, 'exited');
  assert.equal(resumed.session.exitCode, 7);
  assert.equal(resumed.replay.data, 'finished\r\n');
  f.service.shutdown();
  assert.equal(f.pty.kills, 0, 'already exited PTY is not killed again');
  assert.throws(() => f.service.attachSession({...attachRequest, sessionId:first.session.id}), /不存在/);
});

test('bounded replay declares truncation and starts after a whole line without a split surrogate', t => {
  const f = fixture(t);
  const first = f.service.attachSession(attachRequest);
  f.service.detachSession(identity(first));
  f.pty.data('old'.repeat(TERMINAL_REPLAY_LIMIT));
  f.pty.data('\u001b[31m😀partial\r\ncomplete 😀 line\r\n');
  const replay = f.service.attachSession(attachRequest).replay;
  assert.equal(replay.truncated, true);
  assert.ok(replay.data.length <= TERMINAL_REPLAY_LIMIT);
  assert.equal(replay.data, 'complete 😀 line\r\n');
  assert.equal(replay.startSequence + replay.data.length, replay.sequence);
  assert.doesNotMatch(replay.data, /^[\uDC00-\uDFFF]/u);
});

test('replay cursor clips overlapping batches and rejects duplicate or foreign attachment output', () => {
  const cursor = new TerminalOutputCursor('session', 'new', 6);
  const event = {sessionId:'session', attachmentId:'new', startSequence:3, sequence:9, data:'456789'};
  assert.deepEqual(cursor.accept(event), {data:'789', gap:false});
  assert.equal(cursor.accept(event), null);
  assert.equal(cursor.accept({...event, attachmentId:'old', startSequence:9,sequence:10,data:'x'}), null);
  assert.deepEqual(cursor.accept({...event,startSequence:12,sequence:15,data:'abc'}),{data:'abc',gap:true});
});

test('batching keeps lease and sequence boundaries while combining only contiguous output', () => {
  const sent = [], batcher = createTerminalOutputBatcher({intervalMs:1000,send:event=>sent.push(event)});
  const event = {sessionId:'s',attachmentId:'a',startSequence:0,sequence:2,data:'ab'};
  batcher.schedule(event);
  batcher.schedule({...event,startSequence:2,sequence:4,data:'cd'});
  batcher.schedule({...event,attachmentId:'b',startSequence:4,sequence:6,data:'ef'});
  batcher.flush();
  assert.deepEqual(sent,[{...event,sequence:4,data:'abcd'},{...event,attachmentId:'b',startSequence:4,sequence:6,data:'ef'}]);
});

test('retained session capacity is bounded per actual window owner', t => {
  const f = fixture(t);
  for(let n=0;n<16;n++) withTerminalOwner(41,()=>f.service.createSession({cols:80,rows:24}));
  assert.throws(()=>withTerminalOwner(41,()=>f.service.createSession({cols:80,rows:24})),error=>error.code==='terminal_session_limit');
  assert.doesNotThrow(()=>withTerminalOwner(42,()=>f.service.createSession({cols:80,rows:24})));
  f.service.closeOwner(41);
  assert.doesNotThrow(()=>withTerminalOwner(41,()=>f.service.createSession({cols:80,rows:24})));
});
