import { chmod, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { writeFrozenManifest } from '../../../../src/main/plugins/research/research-frozen-manifest';
import { ResearchJobSession } from '../../../../src/main/plugins/research/research-job-session';

describe('research job session', () => {
  it('rejects work after shutdown', async () => {
    const session = new ResearchJobSession('research_job_closed');
    await session.shutdown();
    await expect(session.run(async () => 'ok')).rejects.toThrow('research_job_closed');
    await expect(session.guard(async () => 'ok')).rejects.toThrow('research_job_closed');
  });
});

describe('frozen research manifest', () => {
  it('writes once and rejects a changed replay', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-manifest-')));
    const first = await writeFrozenManifest({
      root, path: 'manifest.json', content: '{"ok":true}', limit: 1024, changedCode: 'research_manifest_changed'
    });
    const second = await writeFrozenManifest({
      root, path: 'manifest.json', content: '{"ok":true}', limit: 1024, changedCode: 'research_manifest_changed'
    });
    expect(second).toBe(first);
    expect(await readFile(join(root, 'manifest.json'), 'utf8')).toBe('{"ok":true}');
    await chmod(join(root, 'manifest.json'), 0o600);
    await writeFile(join(root, 'manifest.json'), '{"ok":false}');
    await expect(writeFrozenManifest({
      root, path: 'manifest.json', content: '{"ok":true}', limit: 1024, changedCode: 'research_manifest_changed'
    })).rejects.toThrow('research_manifest_changed');
  });
});
