import {before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readdir, realpath, rename, rm, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
let reserve;
before(async () => {({acquireOvisOperationReservation: reserve} = await importTypeScriptModule(
  'src/main/plugins/research/ovis-operation-reservation.ts', {platform: 'node'}));});
const boot = '11111111-1111-1111-1111-111111111111', oldBoot = '22222222-2222-2222-2222-222222222222';
const marker = `.ovis-in-use-${boot}`;
async function fixture(run) {
  const root = await realpath(await mkdtemp('/private/tmp/roc-ovis-reservation-test-'));
  try {await run(root);} finally {await rm(root, {recursive: true, force: true});}
}

test('concurrent holders share a durable marker until the last confirmed release', async () => {
  await fixture(async root => {
    const [first, second] = await Promise.all([reserve(root, async () => boot), reserve(root, async () => boot)]);
    assert.deepEqual(await readdir(root), [marker]);
    first.release(); first.release(); assert.deepEqual(await readdir(root), [marker]);
    second.release(); assert.deepEqual(await readdir(root), []);
    const retry = await reserve(root, async () => boot); retry.release(); assert.deepEqual(await readdir(root), []);
  });
});

test('same-boot unresolved use blocks acquisition; a simulated OS reboot clears only an intact old marker', async () => {
  await fixture(async root => {
    await writeFile(join(root, marker), '', {mode: 0o600});
    await assert.rejects(reserve(root, async () => boot), /previous_operation_unresolved/);
    await writeFile(join(root, 'keep'), 'user');
    const fresh = await reserve(root, async () => oldBoot);
    assert.deepEqual((await readdir(root)).sort(), [`.ovis-in-use-${oldBoot}`, 'keep'].sort());
    fresh.release(); assert.deepEqual(await readdir(root), ['keep']);
  });
});

test('replaced current marker and malformed stale markers are preserved', async () => {
  await fixture(async root => {
    const first = await reserve(root, async () => boot);
    await rename(join(root, marker), join(root, 'saved'));
    await writeFile(join(root, marker), 'unrelated');
    assert.throws(() => first.release(), /marker_changed/);
    await assert.rejects(reserve(root, async () => boot), /marker_changed/);
    assert.deepEqual((await readdir(root)).sort(), [marker, 'saved'].sort());
  });
  await fixture(async root => {
    await writeFile(join(root, `.ovis-in-use-${oldBoot}`), 'unrelated', {mode: 0o600});
    await assert.rejects(reserve(root, async () => boot), /marker_invalid/);
    assert.deepEqual(await readdir(root), [`.ovis-in-use-${oldBoot}`]);
  });
});

test('unknown boot identity and path aliases cannot authorize acquisition', async () => {
  await fixture(async root => {
    await assert.rejects(reserve(root, async () => '../unknown'), /boot_identity_invalid/);
    await symlink(root, join(root, 'alias'));
    await assert.rejects(reserve(join(root, 'alias'), async () => boot), /directory_invalid/);
    assert.deepEqual(await readdir(root), ['alias']);
  });
});
