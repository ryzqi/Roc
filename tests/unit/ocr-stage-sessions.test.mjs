import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

const {OcrStageSessions} = await importTypeScriptModule('src/main/plugins/research/ocr-stage-sessions.ts');
const {withOcrSessionScope} = await importTypeScriptModule('src/main/plugins/research/ocr-session-scope.ts');
const deferred = () => Promise.withResolvers();
function nativeFactory(events, name, overrides = {}) {
  return async () => {
    events.push(`open:${name}`);
    return {inputNames:['input'],outputNames:['output'],inputMetadata:[{shape:[1,3,64,64]}],
      run:async feeds => {events.push(`run:${name}`); return {output:feeds.input};},
      release:async () => {events.push(`release:${name}`);}, ...overrides};
  };
}

test('stage transition waits for native release before allocating another stage', async () => {
  const events=[], held=deferred(), entered=deferred();
  const sessions=new OcrStageSessions(new AbortController().signal);
  await sessions.create('layout', nativeFactory(events,'layout',{release:async () => {
    events.push('release:layout'); entered.resolve(); await held.promise;
  }}));
  const pending=sessions.create('ocr',nativeFactory(events,'detection'));
  try {
    await entered.promise; await nextTurn();
    assert.deepEqual(events,['open:layout','release:layout']);
  } finally {held.resolve();}
  await pending; await sessions.release();
  assert.deepEqual(events,['open:layout','release:layout','open:detection','release:detection']);
});

test('OCR pair shares its stage; later runs reopen sessions and preserve metadata and results', async () => {
  const events=[], sessions=new OcrStageSessions(new AbortController().signal);
  const det=await sessions.create('ocr',nativeFactory(events,'detection'));
  const rec=await sessions.create('ocr',nativeFactory(events,'recognition'));
  assert.deepEqual(events,['open:detection','open:recognition']);
  const table=await sessions.create('table',nativeFactory(events,'table'));
  assert.deepEqual(events.slice(2),['release:detection','release:recognition','open:table']);
  const tensor={data:[1,2,3]};
  assert.deepEqual(await det.run({input:tensor}),{output:tensor});
  assert.deepEqual(await rec.run({input:tensor}),{output:tensor});
  assert.deepEqual(det.inputNames,['input']);
  assert.deepEqual(det.inputMetadata,[{shape:[1,3,64,64]}]);
  assert.deepEqual(det.outputNames,['output']);
  assert.deepEqual(events.slice(5),['release:table','open:detection','run:detection','open:recognition','run:recognition']);
  await sessions.releaseIdle();
  assert.deepEqual(events.slice(-2),['release:detection','release:recognition']);
  await table.run({input:tensor});
  await sessions.release(); await sessions.release();
  assert.deepEqual(events.slice(-3),['open:table','run:table','release:table']);
  await assert.rejects(det.run({input:tensor}),/sessions_closed/);
});

for (const boundary of ['open','run']) test(`cancel during native ${boundary} waits for settlement and release`, async () => {
  const events=[], controller=new AbortController(), entered=deferred(), held=deferred(), released=deferred(), cleanup=deferred();
  let finished=false;
  const operation=withOcrSessionScope(async register => {
    const sessions=new OcrStageSessions(controller.signal); register(sessions);
    const model=await sessions.create('ocr',async () => {
      if (boundary==='open') {entered.resolve(); await held.promise;}
      return await nativeFactory(events,'ocr',{
        run:async () => {entered.resolve(); await held.promise; return {output:1};},
        release:async () => {events.push('release'); released.resolve(); await cleanup.promise;}
      })();
    });
    await model.run({input:1});
  });
  const outcome=assert.rejects(operation,/abort/i).then(()=>{finished=true;});
  try {
    await entered.promise; controller.abort(); await nextTurn();
    assert.equal(finished,false); assert.equal(events.includes('release'),false);
    held.resolve(); await released.promise; await nextTurn();
    assert.equal(finished,false);
  } finally {held.resolve(); cleanup.resolve();}
  await outcome;
  assert.equal(events.filter(e=>e==='release').length,1);
});

test('native release failures remain visible and prevent replacement allocation', async () => {
  const events=[], sessions=new OcrStageSessions(new AbortController().signal), error=new Error('native release failed');
  await sessions.create('ocr',nativeFactory(events,'detection',{release:async()=>{throw error;}}));
  await sessions.create('ocr',nativeFactory(events,'recognition'));
  await assert.rejects(sessions.releaseIdle(),e=>e instanceof AggregateError && e.errors[0]===error);
  assert.ok(events.includes('release:recognition'),'other native resources still release');
  await assert.rejects(sessions.create('ocr',nativeFactory(events,'replacement')),e=>e===error);
  await assert.rejects(sessions.create('table',nativeFactory(events,'table')),e=>e===error);
  assert.equal(events.some(e=>e==='open:replacement'||e==='open:table'),false);
  await assert.rejects(sessions.release(),/session_release_failed/);
});
