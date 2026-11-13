import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

const {handleExternalNavigation} = await importTypeScriptModule('src/main/external-link-policy.ts');

function fixture(openExternal) {
  const warnings = [];
  return {
    warnings,
    input: {
      shell: {openExternal},
      logService: {warn: (...args) => warnings.push(args)}
    }
  };
}

test('a synchronous OS browser failure keeps navigation denied and reports the native failure', () => {
  const {input, warnings} = fixture(() => {throw new Error('OS browser unavailable');});
  let result;
  assert.doesNotThrow(() => {result = handleExternalNavigation('https://example.test/paper', input);});
  assert.deepEqual(result, {action: 'deny'});
  assert.equal(warnings.length, 1);
  assert.match(JSON.stringify(warnings), /OS browser unavailable/);
});

test('a rejected OS browser request is handled at the native navigation boundary', async () => {
  const {input, warnings} = fixture(() => Promise.reject(new Error('Browser launch rejected')));
  assert.deepEqual(handleExternalNavigation('https://example.test/paper', input), {action: 'deny'});
  await nextTurn();
  assert.equal(warnings.length, 1);
  assert.match(JSON.stringify(warnings), /Browser launch rejected/);
});

test('successful external opens stay in the OS browser and unsupported schemes never reach it', async () => {
  const opened = [];
  const {input, warnings} = fixture(async url => {opened.push(url);});
  for (const url of ['https://example.test/paper', 'http://example.test/']) {
    assert.deepEqual(handleExternalNavigation(url, input), {action: 'deny'});
  }
  for (const url of ['javascript:alert(1)', 'file:///tmp/paper.pdf', 'invalid URL']) {
    assert.deepEqual(handleExternalNavigation(url, input), {action: 'deny'});
  }
  await nextTurn();
  assert.deepEqual(opened, ['https://example.test/paper', 'http://example.test/']);
  assert.equal(warnings.length, 3);
});
