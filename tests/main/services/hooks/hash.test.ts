import { describe, expect, it } from 'vitest';
import { computeHookHandlerHash } from '../../../../src/main/services/hooks/hash';

describe('computeHookHandlerHash', () => {
  it('changes when command changes', () => {
    const first = computeHookHandlerHash({
      event: 'PreToolUse',
      matcher: '^run_shell_command$',
      handler: {
        type: 'command',
        command: 'node first.js',
        timeoutSeconds: 30,
        enabled: true,
        failureMode: 'continue'
      }
    });
    const second = computeHookHandlerHash({
      event: 'PreToolUse',
      matcher: '^run_shell_command$',
      handler: {
        type: 'command',
        command: 'node second.js',
        timeoutSeconds: 30,
        enabled: true,
        failureMode: 'continue'
      }
    });

    expect(first).not.toEqual(second);
  });

  it('ignores statusMessage', () => {
    const base = {
      event: 'Stop' as const,
      matcher: null,
      handler: {
        type: 'command' as const,
        command: 'node stop.js',
        timeoutSeconds: 30,
        enabled: true,
        failureMode: 'continue' as const
      }
    };

    expect(computeHookHandlerHash(base)).toEqual(
      computeHookHandlerHash({
        ...base,
        handler: {
          ...base.handler,
          statusMessage: 'Changed display text'
        }
      })
    );
  });

  it('ignores enabled state', () => {
    const base = {
      event: 'UserPromptSubmit' as const,
      matcher: null,
      handler: {
        type: 'command' as const,
        command: 'node prompt.js',
        timeoutSeconds: 30,
        enabled: true,
        failureMode: 'continue' as const
      }
    };

    expect(computeHookHandlerHash(base)).toEqual(
      computeHookHandlerHash({
        ...base,
        handler: {
          ...base.handler,
          enabled: false
        }
      })
    );
  });
});
