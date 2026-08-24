import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigService } from '../../../../src/main/services/config-service';
import { HookCommandRunner } from '../../../../src/main/services/hooks/command-runner';
import { HookConfigService } from '../../../../src/main/services/hooks/config-service';
import { HookTrustService } from '../../../../src/main/services/hooks/trust-service';
import { RocPaths } from '../../../../src/main/services/paths';
import { SelfConfigService } from '../../../../src/main/services/self-config';

type Harness = {
  root: string;
  paths: RocPaths;
  configService: ConfigService;
  hookConfigService: HookConfigService;
  service: SelfConfigService;
};

function createHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'roc-self-config-'));
  const paths = new RocPaths(root);
  paths.ensureTree();
  const hookTrustService = new HookTrustService(paths);
  const hookConfigService = new HookConfigService(paths, hookTrustService);
  const configService = new ConfigService(paths);
  configService.initialize();
  return {
    root,
    paths,
    configService,
    hookConfigService,
    service: new SelfConfigService({
      paths,
      hookConfigService,
      hookTrustService,
      commandRunner: new HookCommandRunner(),
      configService
    })
  };
}

describe('SelfConfigService.describe', () => {
  it('reports the real Roc config paths, the six events and their allowed actions', () => {
    const harness = createHarness();

    const result = harness.service.describe();

    expect(result.paths).toEqual({
      rocRoot: harness.root,
      hooksConfig: join(harness.root, 'hooks.json'),
      settings: join(harness.root, 'config', 'settings.json'),
      hooksTrust: join(harness.root, 'config', 'hooks-trust.json'),
      skillsDir: join(harness.root, 'skills'),
      logsDir: join(harness.root, 'logs')
    });
    expect(result.events.map((event) => event.event)).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'Stop',
      'SessionEnd'
    ]);
    expect(result.events.find((event) => event.event === 'Stop')?.allowedActions).toContain('request_continue');
    expect(result.events.find((event) => event.event === 'SessionEnd')?.allowedActions).toEqual(['continue']);
    expect(result.events.find((event) => event.event === 'PreToolUse')?.matcherTarget).toContain('toolName');
  });

  it('exposes the hooks JSON Schema with timeoutSeconds as an optional field', () => {
    const harness = createHarness();

    const schema = harness.service.describe().hookConfigJsonSchema as {
      properties: {
        hooks: {
          properties: Record<string, unknown>;
        };
      };
    };
    const serialized = JSON.stringify(schema);

    expect(Object.keys(schema.properties.hooks.properties)).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'Stop',
      'SessionEnd'
    ]);
    expect(serialized).toContain('timeoutSeconds');
    expect(serialized).not.toContain('"timeout"');
    expect(serialized).toContain('"required":["type","command"]');
  });
});

describe('SelfConfigService.read', () => {
  it('returns the hooks snapshot with trust state and never leaks credential values', async () => {
    const harness = createHarness();
    await harness.hookConfigService.saveConfig({
      schemaVersion: 1,
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: 'node init.js',
                timeoutSeconds: 30,
                enabled: true,
                failureMode: 'continue'
              }
            ]
          }
        ]
      }
    });
    harness.configService.saveProviders({
      schemaVersion: 2,
      defaultModelId: 'demo/model-a',
      providers: [
        {
          id: 'demo',
          name: 'Demo',
          type: 'openai_compatible',
          endpoint: 'https://example.invalid/v1',
          credentialRef: 'secret:demo',
          enabled: true,
          models: [
            {
              id: 'model-a',
              displayName: 'Model A',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true,
              supportsImages: false
            }
          ]
        }
      ]
    });

    const result = await harness.service.read();

    expect(result.hooks.configPath).toBe(join(harness.root, 'hooks.json'));
    expect(result.hooks.exists).toBe(true);
    expect(result.hooks.handlers).toHaveLength(1);
    expect(result.hooks.handlers[0]?.id).toBe('SessionStart:0:0');
    expect(result.hooks.handlers[0]?.trustState).toBe('review_required');
    expect(result.settings.settingsPath).toBe(join(harness.root, 'config', 'settings.json'));
    expect(result.settings.defaultModelId).toBe('demo/model-a');
    expect(JSON.stringify(result.settings.providers)).not.toContain('secret:demo');
    expect(JSON.stringify(result.settings.providers)).toContain('[set]');
  });

  it('masks credential-like keys without turning non-string values into strings', async () => {
    const harness = createHarness();
    const settings = harness.configService.getSettings();

    const result = await harness.service.read();
    const readSettings = result.settings.settings as typeof settings;

    expect(typeof settings.memory.securityScan.credential).toBe('boolean');
    expect(readSettings.memory.securityScan.credential).toBe(settings.memory.securityScan.credential);
  });
});

describe('SelfConfigService.validate', () => {
  it('translates Codex-style hooks.json into targeted Roc hints', () => {
    const harness = createHarness();

    const result = harness.service.validate(
      JSON.stringify({
        schemaVersion: 1,
        hooks: {
          PreCompact: [{ hooks: [{ type: 'command', command: 'bash compact.sh' }] }],
          SessionStart: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'bash init-session.sh',
                  timeout: 5,
                  loop_limit: 3
                }
              ]
            }
          ]
        }
      })
    );

    expect(result.valid).toBe(false);
    expect(result.normalizedConfig).toBeNull();
    const hints = result.issues.map((issue) => issue.hint).join('\n');
    expect(hints).toContain('timeoutSeconds');
    expect(hints).toContain('loop_limit');
    expect(hints).toContain('PreCompact 不是 Roc 的事件名');
    expect(hints).toContain('SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、Stop、SessionEnd');
    expect(result.notes.join('\n')).toContain('hookSpecificOutput');
  });

  it('accepts a valid config, fills defaults and never writes hooks.json', async () => {
    const harness = createHarness();

    const result = harness.service.validate({
      schemaVersion: 1,
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'node stop.js' }] }]
      }
    });

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.normalizedConfig?.hooks.Stop?.[0]?.hooks[0]).toEqual({
      type: 'command',
      command: 'node stop.js',
      timeoutSeconds: 30,
      enabled: true,
      failureMode: 'continue'
    });
    expect((await harness.hookConfigService.loadConfigSnapshot()).exists).toBe(false);
  });

  it('fails explicitly on invalid JSON text', () => {
    const harness = createHarness();

    expect(() => harness.service.validate('{ "schemaVersion": 1, ')).toThrow(/self_config_validate_json_invalid/u);
  });
});

describe('SelfConfigService.dryRun', () => {
  it('rejects a handler id that is not present in hooks.json', async () => {
    const harness = createHarness();
    await harness.hookConfigService.saveConfig({
      schemaVersion: 1,
      hooks: {
        SessionStart: [
          {
            hooks: [{ type: 'command', command: 'node init.js', timeoutSeconds: 30, enabled: true, failureMode: 'continue' }]
          }
        ]
      }
    });

    await expect(
      harness.service.dryRun({ handlerId: 'Stop:0:0', confirm: async () => true })
    ).rejects.toThrow('self_config_dry_run_handler_not_found:Stop:0:0:available=SessionStart:0:0');
  });

  it('runs an existing handler and returns its exit code and stderr', async () => {
    const harness = createHarness();
    const script = join(harness.root, 'failing-hook.cjs');
    writeFileSync(script, ['process.stderr.write("init-session.sh: line 3: not found");', 'process.exit(3);'].join('\n'), 'utf8');
    await harness.hookConfigService.saveConfig({
      schemaVersion: 1,
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: `node "${script}"`,
                timeoutSeconds: 10,
                enabled: true,
                failureMode: 'continue'
              }
            ]
          }
        ]
      }
    });

    const result = await harness.service.dryRun({ handlerId: 'SessionStart:0:0', confirm: async () => true });

    expect(result.status).toBe('failed');
    expect(result.error).toBe('hook_command_exit_3');
    expect(result.stderr).toContain('not found');
    expect(result.event).toBe('SessionStart');
    expect(result.trustState).toBe('review_required');
    expect(result.cwd).toBe(harness.root);
  });

  it('runs an untrusted handler and reports whether its action is accepted by the event', async () => {
    const harness = createHarness();
    const script = join(harness.root, 'blocking-hook.cjs');
    writeFileSync(script, 'process.stdout.write(JSON.stringify({ action: "block", message: "no" }));', 'utf8');
    await harness.hookConfigService.saveConfig({
      schemaVersion: 1,
      hooks: {
        SessionEnd: [
          {
            hooks: [
              {
                type: 'command',
                command: `node "${script}"`,
                timeoutSeconds: 10,
                enabled: true,
                failureMode: 'continue'
              }
            ]
          }
        ]
      }
    });

    const result = await harness.service.dryRun({ handlerId: 'SessionEnd:0:0', confirm: async () => true });

    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ action: 'block', message: 'no' });
    expect(result.actionAcceptedByEvent).toBe(false);
    expect(result.actionRejectedReason).toBe('unsupported_hook_action:SessionEnd:block');
  });

  it('does not spawn anything when the confirmation is declined', async () => {
    const harness = createHarness();
    const marker = join(harness.root, 'spawned.txt');
    const script = join(harness.root, 'marker-hook.cjs');
    writeFileSync(
      script,
      [`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran', 'utf8');`, 'process.stdout.write("");'].join('\n'),
      'utf8'
    );
    await harness.hookConfigService.saveConfig({
      schemaVersion: 1,
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: 'command',
                command: `node "${script}"`,
                timeoutSeconds: 10,
                enabled: true,
                failureMode: 'continue'
              }
            ]
          }
        ]
      }
    });

    const result = await harness.service.dryRun({ handlerId: 'Stop:0:0', confirm: async () => false });

    expect(result.status).toBe('declined');
    expect(result.error).toBe('self_config_dry_run_declined');
    expect(result.durationMs).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it('tells the confirmation whether the handler would run for real', async () => {
    const harness = createHarness();
    await harness.hookConfigService.saveConfig({
      schemaVersion: 1,
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: 'command',
                command: 'node --version',
                timeoutSeconds: 10,
                enabled: false,
                failureMode: 'continue'
              }
            ]
          }
        ]
      }
    });
    const confirmRequests: Array<{ enabled: boolean; trustState: string }> = [];

    const result = await harness.service.dryRun({
      handlerId: 'Stop:0:0',
      confirm: async (request) => {
        confirmRequests.push({ enabled: request.enabled, trustState: request.trustState });
        return false;
      }
    });

    expect(confirmRequests).toEqual([{ enabled: false, trustState: 'disabled' }]);
    expect(result.status).toBe('declined');
  });
});
