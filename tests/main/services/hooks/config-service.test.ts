import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HookConfigService } from '../../../../src/main/services/hooks/config-service';
import { HookTrustService } from '../../../../src/main/services/hooks/trust-service';
import { RocPaths } from '../../../../src/main/services/paths';

describe('HookConfigService', () => {
  it('returns an empty config when hooks.json does not exist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'roc-hooks-'));
    const service = new HookConfigService(new RocPaths(root));

    const snapshot = await service.loadConfigSnapshot();

    expect(snapshot.configPath).toBe(join(root, 'hooks.json'));
    expect(snapshot.exists).toBe(false);
    expect(snapshot.config).toEqual({ schemaVersion: 1, hooks: {} });
    expect(snapshot.validationErrors).toEqual([]);
    expect(snapshot.handlers).toEqual([]);
  });

  it('writes hooks.json under the Roc root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'roc-hooks-'));
    const service = new HookConfigService(new RocPaths(root));

    const snapshot = await service.saveConfig({
      schemaVersion: 1,
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: 'command',
                command: 'node prompt.js',
                timeoutSeconds: 30,
                enabled: true,
                failureMode: 'continue'
              }
            ]
          }
        ]
      }
    });

    expect(snapshot.exists).toBe(true);
    expect(snapshot.config.hooks.UserPromptSubmit?.[0]?.hooks[0]?.command).toBe('node prompt.js');
    expect(JSON.parse(readFileSync(join(root, 'hooks.json'), 'utf8'))).toMatchObject({
      schemaVersion: 1,
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                command: 'node prompt.js'
              }
            ]
          }
        ]
      }
    });
  });

  it('merges trusted handler hashes into snapshots', async () => {
    const root = mkdtempSync(join(tmpdir(), 'roc-hooks-'));
    const paths = new RocPaths(root);
    const trustService = new HookTrustService(paths);
    const service = new HookConfigService(paths, trustService);
    const saved = await service.saveConfig({
      schemaVersion: 1,
      hooks: {
        PreToolUse: [
          {
            matcher: '^run_shell_command$',
            hooks: [
              {
                type: 'command',
                command: 'node check-shell.js',
                timeoutSeconds: 30,
                enabled: true,
                failureMode: 'continue'
              }
            ]
          }
        ]
      }
    });
    const handler = saved.handlers[0];
    if (handler === undefined) {
      throw new Error('expected handler snapshot');
    }

    expect(handler.trustState).toBe('review_required');

    await trustService.trust({ handlerId: handler.id, hash: handler.hash });

    const loaded = await service.loadConfigSnapshot();

    expect(loaded.handlers[0]?.trustState).toBe('trusted');
  });

  it('keeps valid hook config visible when trust storage is invalid', async () => {
    const root = mkdtempSync(join(tmpdir(), 'roc-hooks-'));
    const paths = new RocPaths(root);
    const service = new HookConfigService(paths, new HookTrustService(paths));
    await service.saveConfig({
      schemaVersion: 1,
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: 'command',
                command: 'node stop.js',
                timeoutSeconds: 30,
                enabled: true,
                failureMode: 'continue'
              }
            ]
          }
        ]
      }
    });
    mkdirSync(paths.configDir, { recursive: true });
    writeFileSync(join(paths.configDir, 'hooks-trust.json'), '{ "schemaVersion": 1, "trusted": [] }\n', 'utf8');

    const snapshot = await service.loadConfigSnapshot();

    expect(snapshot.config.hooks.Stop?.[0]?.hooks[0]?.command).toBe('node stop.js');
    expect(snapshot.handlers[0]?.trustState).toBe('review_required');
    expect(snapshot.validationErrors).toEqual(['hooks_trust_document_invalid']);
  });
});
