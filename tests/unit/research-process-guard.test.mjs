import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import guard from '../../resources/research-runtime/process-guard.lock.json' with { type: 'json' };

test('shipped supervisor bytes match their source lock and arm64 executable contract', async () => {
  const hash = value => createHash('sha256').update(value).digest('hex');
  const source = await readFile(new URL('../../resources/research-runtime/process-guard.c', import.meta.url));
  const binary = Buffer.from(guard.data, 'base64');
  assert.equal(hash(source), guard.sourceHash);
  assert.equal(hash(binary), guard.sha256);
  assert.deepEqual(guard.architectures, ['arm64']);
  assert.equal(binary.readUInt32LE(0), 0xfeedfacf);
  assert.equal(binary.readUInt32LE(4), 0x0100000c);
  assert.equal(binary.readUInt32LE(12), 2);
});
