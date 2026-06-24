import { describe, expect, it } from 'vitest';
import {
  HookCommandOutputSchema,
  HookConfigSchema,
  validateHookCommandOutputForEvent
} from '../../../../src/main/services/hooks/schema';

describe('HookConfigSchema', () => {
  it('normalizes command hook defaults', () => {
    const parsed = HookConfigSchema.parse({
      schemaVersion: 1,
      hooks: {
        PreToolUse: [
          {
            matcher: '^run_shell_command$',
            hooks: [
              {
                type: 'command',
                command: 'powershell -NoProfile -File C:\\Users\\me\\.roc\\hooks\\check.ps1'
              }
            ]
          }
        ]
      }
    });

    expect(parsed.hooks.PreToolUse?.[0]?.hooks[0]).toMatchObject({
      type: 'command',
      timeoutSeconds: 30,
      enabled: true,
      failureMode: 'continue'
    });
  });

  it('rejects unsupported handler types', () => {
    expect(() =>
      HookConfigSchema.parse({
        schemaVersion: 1,
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'prompt',
                  prompt: 'not supported'
                }
              ]
            }
          ]
        }
      })
    ).toThrow();
  });

  it('rejects invalid timeout values', () => {
    expect(() =>
      HookConfigSchema.parse({
        schemaVersion: 1,
        hooks: {
          SessionStart: [
            {
              matcher: 'chat',
              hooks: [
                {
                  type: 'command',
                  command: 'node hook.js',
                  timeoutSeconds: 601
                }
              ]
            }
          ]
        }
      })
    ).toThrow();
  });

  it('rejects unknown event names', () => {
    expect(() =>
      HookConfigSchema.parse({
        schemaVersion: 1,
        hooks: {
          BeforeToolUse: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'node hook.js'
                }
              ]
            }
          ]
        }
      })
    ).toThrow();
  });
});

describe('HookCommandOutputSchema', () => {
  it('parses add_context output', () => {
    expect(
      HookCommandOutputSchema.parse({
        action: 'add_context',
        message: 'context added',
        additionalContext: 'Use safer shell commands.'
      })
    ).toEqual({
      action: 'add_context',
      message: 'context added',
      additionalContext: 'Use safer shell commands.'
    });
  });

  it('rejects invalid action', () => {
    expect(() => HookCommandOutputSchema.parse({ action: 'pause' })).toThrow();
  });
});

describe('validateHookCommandOutputForEvent', () => {
  it('accepts valid action and event combinations', () => {
    expect(validateHookCommandOutputForEvent('PreToolUse', { action: 'replace_input', updatedInput: { command: 'pwd' } })).toEqual({
      action: 'replace_input',
      updatedInput: { command: 'pwd' }
    });
    expect(validateHookCommandOutputForEvent('Stop', { action: 'request_continue', message: 'Continue.' })).toEqual({
      action: 'request_continue',
      message: 'Continue.'
    });
    expect(validateHookCommandOutputForEvent('SessionStart', { action: 'add_context', additionalContext: 'Policy context.' })).toEqual({
      action: 'add_context',
      additionalContext: 'Policy context.'
    });
  });

  it('rejects block for PostToolUse', () => {
    expect(() => validateHookCommandOutputForEvent('PostToolUse', { action: 'block' })).toThrow(/unsupported_hook_action/);
  });

  it('rejects replace_input outside PreToolUse', () => {
    expect(() => validateHookCommandOutputForEvent('UserPromptSubmit', { action: 'replace_input', updatedInput: 'x' })).toThrow(
      /unsupported_hook_action/
    );
  });

  it('rejects request_continue outside Stop', () => {
    expect(() => validateHookCommandOutputForEvent('SessionEnd', { action: 'request_continue', message: 'Continue.' })).toThrow(
      /unsupported_hook_action/
    );
  });

  it('rejects add_context for PreToolUse and SessionEnd', () => {
    expect(() => validateHookCommandOutputForEvent('PreToolUse', { action: 'add_context', additionalContext: 'Policy.' })).toThrow(
      /unsupported_hook_action/
    );
    expect(() => validateHookCommandOutputForEvent('SessionEnd', { action: 'add_context', additionalContext: 'Policy.' })).toThrow(
      /unsupported_hook_action/
    );
  });
});
