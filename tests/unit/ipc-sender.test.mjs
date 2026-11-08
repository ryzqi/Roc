import assert from 'node:assert/strict';
import {test} from 'node:test';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

const {createIpcSenderValidator} = await importTypeScriptModule('src/main/ipc/ipc-sender.ts');

for (const entry of ['file:///Applications/Roc.app/renderer/index.html', 'http://localhost:5173/']) {
  test(`IPC authority is bound to window, frame and entry: ${entry}`, () => {
    const frame = {url: entry, origin: entry.startsWith('file:') ? 'file://' : new URL(entry).origin, detached: false};
    const window = {isDestroyed: () => false, webContents: {mainFrame: frame}};
    const event = {sender: window.webContents, senderFrame: frame};
    const validate = createIpcSenderValidator(window, entry);
    assert.equal(validate(event), true);
    frame.url = entry + '?view=literature#selection';
    assert.equal(validate(event), true, 'shell navigation remains within the entry');
    assert.equal(validate({...event, sender: {}}), false);
    assert.equal(validate({...event, senderFrame: null}), false);
    assert.equal(validate({...event, senderFrame: {...frame}}), false, 'same-URL child frame is not authoritative');
    frame.detached = true;
    assert.equal(validate(event), false);
    frame.detached = false;
    frame.origin = 'https://untrusted.invalid';
    assert.equal(validate(event), false);
    frame.origin = entry.startsWith('file:') ? 'file://' : new URL(entry).origin;
    for (const url of [new URL('other.html', entry).href, 'about:blank', 'data:text/html,test', 'https://untrusted.invalid/', 'invalid']) {
      frame.url = url;
      assert.equal(validate(event), false, url);
    }
    frame.url = entry;
    window.isDestroyed = () => true;
    assert.equal(validate(event), false);
  });
}
