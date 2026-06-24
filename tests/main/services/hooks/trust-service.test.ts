import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HookTrustService } from '../../../../src/main/services/hooks/trust-service';
import { RocPaths } from '../../../../src/main/services/paths';

describe('HookTrustService', () => {
  it('trusts and verifies handler hashes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'roc-hooks-'));
    const service = new HookTrustService(new RocPaths(root));

    await service.trust({ handlerId: 'PreToolUse:0:0', hash: 'abc123' });

    expect(await service.isTrusted({ handlerId: 'PreToolUse:0:0', hash: 'abc123' })).toBe(true);
    expect(await service.isTrusted({ handlerId: 'PreToolUse:0:0', hash: 'changed' })).toBe(false);
  });

  it('persists trust across service instances', async () => {
    const root = mkdtempSync(join(tmpdir(), 'roc-hooks-'));
    const paths = new RocPaths(root);
    const first = new HookTrustService(paths);

    await first.trust({ handlerId: 'Stop:0:0', hash: 'stop-hash' });

    const second = new HookTrustService(paths);

    expect(await second.isTrusted({ handlerId: 'Stop:0:0', hash: 'stop-hash' })).toBe(true);
  });
});
