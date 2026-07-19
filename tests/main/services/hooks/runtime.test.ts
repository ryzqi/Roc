import { describe, expect, it, vi } from 'vitest';
import { HookRuntime } from '../../../../src/main/services/hooks/runtime';
import type { HookCommandRunRequest, HookCommandRunResult } from '../../../../src/main/services/hooks/command-runner';
import type { RocHookCommandInput, RocHookConfig, RocHookRunEvent } from '../../../../src/shared/types';

function input(event: RocHookCommandInput['event'], payload: RocHookCommandInput['payload'], cwd = 'F:\\Code\\Roc'): RocHookCommandInput {
  return {
    schemaVersion: 1,
    event,
    runId: 'run_1',
    threadId: 'thread_1',
    workspacePath: cwd,
    cwd,
    triggeredAt: '2026-06-24T10:00:00.000Z',
    payload
  } as RocHookCommandInput;
}

type RunnerFn = (request: HookCommandRunRequest) => Promise<HookCommandRunResult>;

function createRuntime(inputConfig: RocHookConfig, inputDeps: { trusted?: boolean; run?: RunnerFn; emitEvent?: (event: RocHookRunEvent) => void }) {
  const trusted = inputDeps.trusted === undefined ? true : inputDeps.trusted;
  const defaultRun: RunnerFn = async () => ({
    status: 'completed',
    durationMs: 0,
    stdout: '',
    stderr: '',
    output: { action: 'continue' }
  });
  const commandRunner = {
    run: vi.fn<RunnerFn>(inputDeps.run === undefined ? defaultRun : inputDeps.run)
  };
  return {
    commandRunner,
    runtime: new HookRuntime({
      configService: {
        loadConfig: vi.fn(async () => inputConfig)
      },
      trustService: {
        isTrusted: vi.fn(async () => trusted)
      },
      commandRunner,
      emitEvent: inputDeps.emitEvent
    })
  };
}

function preToolConfig(input: { failureMode?: 'continue' | 'block' } = {}): RocHookConfig {
  return {
    schemaVersion: 1,
    hooks: {
      PreToolUse: [
        {
          matcher: '^run_shell_command$',
          hooks: [
            {
              type: 'command',
              command: 'node hook.js',
              timeoutSeconds: 30,
              enabled: true,
              failureMode: input.failureMode === undefined ? 'continue' : input.failureMode
            }
          ]
        }
      ]
    }
  };
}

describe('HookRuntime', () => {
  it('skips untrusted handlers', async () => {
    const { commandRunner, runtime } = createRuntime(preToolConfig(), { trusted: false });

    const outcome = await runtime.runEvent(input('PreToolUse', { toolName: 'run_shell_command', toolCallId: 'call_1', toolInput: {} }));

    expect(outcome.blocked).toBe(false);
    expect(outcome.runs[0]?.status).toBe('skipped');
    expect(outcome.events.map((event) => event.type)).toEqual(['hook_completed']);
    expect(commandRunner.run).not.toHaveBeenCalled();
  });

  it('blocks when a trusted PreToolUse hook returns block', async () => {
    const { runtime } = createRuntime(preToolConfig(), {
      run: async () => ({
        status: 'completed',
        durationMs: 3,
        stdout: '{"action":"block","message":"blocked"}',
        stderr: '',
        output: { action: 'block', message: 'blocked' }
      })
    });

    const outcome = await runtime.runEvent(input('PreToolUse', { toolName: 'run_shell_command', toolCallId: 'call_1', toolInput: {} }));

    expect(outcome.blocked).toBe(true);
    expect(outcome.blockReason).toBe('blocked');
    expect(outcome.events.map((event) => event.type)).toEqual(['hook_started', 'hook_completed']);
    expect(outcome.events[1]?.hook.status).toBe('blocked');
  });

  it('emits started and completed feedback through the runtime callback', async () => {
    const emitted: RocHookRunEvent[] = [];
    const { runtime } = createRuntime(preToolConfig(), {
      emitEvent: (event) => emitted.push(event),
      run: async () => ({
        status: 'completed',
        durationMs: 3,
        stdout: '{"action":"continue"}',
        stderr: '',
        output: { action: 'continue' }
      })
    });

    await runtime.runEvent(input('PreToolUse', { toolName: 'run_shell_command', toolCallId: 'call_1', toolInput: {} }));

    expect(emitted.map((event) => event.type)).toEqual(['hook_started', 'hook_completed']);
    expect(emitted).toMatchObject([
      {
        type: 'hook_started',
        hook: {
          commandDisplay: 'node hook.js'
        }
      },
      {
        type: 'hook_completed',
        hook: {
          commandDisplay: 'node hook.js'
        }
      }
    ]);
  });

  it('rejects virtual cwd before invoking the command runner', async () => {
    const { commandRunner, runtime } = createRuntime(preToolConfig({ failureMode: 'block' }), {});

    const outcome = await runtime.runEvent(
      input('PreToolUse', { toolName: 'run_shell_command', toolCallId: 'call_1', toolInput: {} }, '/workspace/project')
    );

    expect(commandRunner.run).not.toHaveBeenCalled();
    expect(outcome.blocked).toBe(true);
    expect(outcome.blockReason).toBe('hook_cwd_virtual_path');
    expect(outcome.runs[0]?.status).toBe('blocked');
  });

  it('blocks command failures when failureMode is block', async () => {
    const { runtime } = createRuntime(preToolConfig({ failureMode: 'block' }), {
      run: async () => ({
        status: 'failed',
        durationMs: 5,
        stdout: '',
        stderr: 'failed',
        error: 'hook_command_exit_1'
      })
    });

    const outcome = await runtime.runEvent(input('PreToolUse', { toolName: 'run_shell_command', toolCallId: 'call_1', toolInput: {} }));

    expect(outcome.blocked).toBe(true);
    expect(outcome.blockReason).toBe('hook_command_exit_1');
    expect(outcome.runs[0]?.status).toBe('blocked');
  });

  it('continues command failures when failureMode is continue', async () => {
    const { runtime } = createRuntime(preToolConfig({ failureMode: 'continue' }), {
      run: async () => ({
        status: 'failed',
        durationMs: 5,
        stdout: '',
        stderr: 'failed',
        error: 'hook_command_exit_1'
      })
    });

    const outcome = await runtime.runEvent(input('PreToolUse', { toolName: 'run_shell_command', toolCallId: 'call_1', toolInput: {} }));

    expect(outcome.blocked).toBe(false);
    expect(outcome.runs[0]?.status).toBe('failed');
  });

  it('keeps SessionEnd best-effort even when failureMode is block', async () => {
    const { runtime } = createRuntime(
      {
        schemaVersion: 1,
        hooks: {
          SessionEnd: [
            {
              matcher: 'completed',
              hooks: [
                {
                  type: 'command',
                  command: 'node end.js',
                  timeoutSeconds: 30,
                  enabled: true,
                  failureMode: 'block'
                }
              ]
            }
          ]
        }
      },
      {
        run: async () => ({
          status: 'failed',
          durationMs: 4,
          stdout: '',
          stderr: 'failed',
          error: 'hook_command_exit_1'
        })
      }
    );

    const outcome = await runtime.runEvent(input('SessionEnd', { status: 'completed', error: null }));

    expect(outcome.blocked).toBe(false);
    expect(outcome.runs[0]?.status).toBe('failed');
  });

  it('blocks invalid event/action output when failureMode is block', async () => {
    const { runtime } = createRuntime(
      {
        schemaVersion: 1,
        hooks: {
          PostToolUse: [
            {
              matcher: '^run_shell_command$',
              hooks: [
                {
                  type: 'command',
                  command: 'node post.js',
                  timeoutSeconds: 30,
                  enabled: true,
                  failureMode: 'block'
                }
              ]
            }
          ]
        }
      },
      {
        run: async () => ({
          status: 'completed',
          durationMs: 3,
          stdout: '{"action":"block"}',
          stderr: '',
          output: { action: 'block' }
        })
      }
    );

    const outcome = await runtime.runEvent(
      input('PostToolUse', { toolName: 'run_shell_command', toolCallId: 'call_1', toolInput: {}, toolOutput: 'ok' })
    );

    expect(outcome.blocked).toBe(true);
    expect(outcome.blockReason).toContain('unsupported_hook_action');
    expect(outcome.runs[0]?.status).toBe('blocked');
  });

  it('continues invalid event/action output when failureMode is continue', async () => {
    const { runtime } = createRuntime(
      {
        schemaVersion: 1,
        hooks: {
          PostToolUse: [
            {
              matcher: '^run_shell_command$',
              hooks: [
                {
                  type: 'command',
                  command: 'node post.js',
                  timeoutSeconds: 30,
                  enabled: true,
                  failureMode: 'continue'
                }
              ]
            }
          ]
        }
      },
      {
        run: async () => ({
          status: 'completed',
          durationMs: 3,
          stdout: '{"action":"block"}',
          stderr: '',
          output: { action: 'block' }
        })
      }
    );

    const outcome = await runtime.runEvent(
      input('PostToolUse', { toolName: 'run_shell_command', toolCallId: 'call_1', toolInput: {}, toolOutput: 'ok' })
    );

    expect(outcome.blocked).toBe(false);
    expect(outcome.runs[0]?.status).toBe('failed');
  });

  it('merges concurrent handler outputs in configuration order', async () => {
    const { runtime } = createRuntime(
      {
        schemaVersion: 1,
        hooks: {
          PostToolUse: [
            {
              matcher: '^read_file$',
              hooks: [
                {
                  type: 'command',
                  command: 'node first.js',
                  timeoutSeconds: 30,
                  enabled: true,
                  failureMode: 'continue'
                },
                {
                  type: 'command',
                  command: 'node second.js',
                  timeoutSeconds: 30,
                  enabled: true,
                  failureMode: 'continue'
                }
              ]
            }
          ]
        }
      },
      {
        run: async (request: HookCommandRunRequest) => {
          if (request.command.includes('first')) {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return {
              status: 'completed',
              durationMs: 20,
              stdout: '{"action":"add_context","additionalContext":"first"}',
              stderr: '',
              output: { action: 'add_context', additionalContext: 'first' }
            };
          }
          return {
            status: 'completed',
            durationMs: 1,
            stdout: '{"action":"add_context","additionalContext":"second"}',
            stderr: '',
            output: { action: 'add_context', additionalContext: 'second' }
          };
        }
      }
    );

    const outcome = await runtime.runEvent(input('PostToolUse', { toolName: 'read_file', toolCallId: 'call_1', toolInput: {}, toolOutput: 'ok' }));

    expect(outcome.additionalContexts).toEqual(['first', 'second']);
    expect(outcome.runs.map((run) => run.handlerId)).toEqual(['PostToolUse:0:0', 'PostToolUse:0:1']);
  });

  it('runs handlers serially and stops launching later handlers after block', async () => {
    const commands: string[] = [];
    const { commandRunner, runtime } = createRuntime(
      {
        schemaVersion: 1,
        hooks: {
          PreToolUse: [
            {
              matcher: '^read_file$',
              hooks: [
                {
                  type: 'command',
                  command: 'node first.js',
                  timeoutSeconds: 30,
                  enabled: true,
                  failureMode: 'block'
                },
                {
                  type: 'command',
                  command: 'node second.js',
                  timeoutSeconds: 30,
                  enabled: true,
                  failureMode: 'block'
                }
              ]
            }
          ]
        }
      },
      {
        run: async (request) => {
          commands.push(request.command);
          return {
            status: 'completed',
            durationMs: 1,
            stdout: '{"action":"block"}',
            stderr: '',
            output: { action: 'block' }
          };
        }
      }
    );

    const outcome = await runtime.runEvent(input('PreToolUse', { toolName: 'read_file', toolCallId: 'call_1', toolInput: {} }));

    expect(commands).toEqual(['node first.js']);
    expect(commandRunner.run).toHaveBeenCalledTimes(1);
    expect(outcome.blocked).toBe(true);
    expect(outcome.runs).toHaveLength(1);
  });

  it('does not start handlers when the run signal is already aborted', async () => {
    const { commandRunner, runtime } = createRuntime(preToolConfig(), {});
    const controller = new AbortController();
    controller.abort();

    const outcome = await runtime.runEvent(
      input('PreToolUse', { toolName: 'run_shell_command', toolCallId: 'call_1', toolInput: {} }),
      { signal: controller.signal }
    );

    expect(commandRunner.run).not.toHaveBeenCalled();
    expect(outcome.runs).toEqual([]);
    expect(outcome.events).toEqual([]);
  });

  it('copies hook output context fields into completed run summaries', async () => {
    const { runtime } = createRuntime(
      {
        schemaVersion: 1,
        hooks: {
          SessionStart: [
            {
              matcher: 'chat',
              hooks: [
                {
                  type: 'command',
                  command: 'node session-start.js',
                  timeoutSeconds: 30,
                  enabled: true,
                  failureMode: 'continue'
                }
              ]
            }
          ]
        }
      },
      {
        run: async () => ({
          status: 'completed',
          durationMs: 7,
          stdout: '{"action":"add_context","additionalContext":"<EXTREMELY_IMPORTANT>Use superpowers.</EXTREMELY_IMPORTANT>"}',
          stderr: '',
          output: {
            action: 'add_context',
            additionalContext: '<EXTREMELY_IMPORTANT>Use superpowers.</EXTREMELY_IMPORTANT>'
          }
        })
      }
    );

    const outcome = await runtime.runEvent(
      input('SessionStart', {
        source: 'chat',
        modelId: 'openai:gpt-4.1',
        workflowHint: null
      })
    );

    expect(outcome.runs[0]).toMatchObject({
      event: 'SessionStart',
      status: 'completed',
      additionalContext: '<EXTREMELY_IMPORTANT>Use superpowers.</EXTREMELY_IMPORTANT>',
      requestContinue: null
    });
    expect(outcome.events[1]?.hook).toMatchObject({
      event: 'SessionStart',
      additionalContext: '<EXTREMELY_IMPORTANT>Use superpowers.</EXTREMELY_IMPORTANT>',
      requestContinue: null
    });
  });

  it('copies Stop request_continue text into completed run summaries', async () => {
    const { runtime } = createRuntime(
      {
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
      },
      {
        run: async () => ({
          status: 'completed',
          durationMs: 9,
          stdout: '{"action":"request_continue","message":"Please continue."}',
          stderr: '',
          output: { action: 'request_continue', message: 'Please continue.' }
        })
      }
    );

    const outcome = await runtime.runEvent(input('Stop', { lastAssistantMessage: 'partial', visibleOutput: true }));

    expect(outcome.requestContinue).toBe('Please continue.');
    expect(outcome.runs[0]).toMatchObject({
      event: 'Stop',
      status: 'completed',
      additionalContext: null,
      requestContinue: 'Please continue.'
    });
  });
});
