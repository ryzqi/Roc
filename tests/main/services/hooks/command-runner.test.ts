import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HookCommandRunner } from '../../../../src/main/services/hooks/command-runner';

describe('HookCommandRunner', () => {
  it('passes JSON input on stdin and parses stdout JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'roc-hooks-'));
    const script = join(dir, 'hook.cjs');
    writeFileSync(
      script,
      [
        'let input = "";',
        'process.stdin.on("data", chunk => input += chunk);',
        'process.stdin.on("end", () => {',
        '  const parsed = JSON.parse(input);',
        '  process.stdout.write(JSON.stringify({ action: "add_context", additionalContext: parsed.event }));',
        '});'
      ].join('\n'),
      'utf8'
    );

    const result = await new HookCommandRunner().run({
      command: `node "${script}"`,
      cwd: dir,
      timeoutSeconds: 5,
      input: {
        schemaVersion: 1,
        event: 'UserPromptSubmit',
        runId: 'run_1',
        threadId: 'thread_1',
        workspacePath: dir,
        cwd: dir,
        triggeredAt: '2026-06-24T10:00:00.000Z',
        payload: { prompt: 'hello' }
      }
    });

    if (result.status !== 'completed') {
      throw new Error('expected completed hook result');
    }
    expect(result.output).toEqual({ action: 'add_context', additionalContext: 'UserPromptSubmit' });
  });

  it('reports invalid JSON output as failed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'roc-hooks-'));
    const script = join(dir, 'hook.cjs');
    writeFileSync(script, 'process.stdout.write("not json");', 'utf8');

    const result = await new HookCommandRunner().run({
      command: `node "${script}"`,
      cwd: dir,
      timeoutSeconds: 5,
      input: {
        schemaVersion: 1,
        event: 'Stop',
        runId: 'run_1',
        threadId: 'thread_1',
        workspacePath: dir,
        cwd: dir,
        triggeredAt: '2026-06-24T10:00:00.000Z',
        payload: { lastAssistantMessage: null, visibleOutput: false }
      }
    });

    if (result.status !== 'failed') {
      throw new Error('expected failed hook result');
    }
    expect(result.error).toContain('hook_output_json_invalid');
  });

  it('rejects virtual cwd before spawning a command', async () => {
    const result = await new HookCommandRunner().run({
      command: 'node -e "process.stdout.write(String(1))"',
      cwd: '/workspace/project',
      timeoutSeconds: 5,
      input: {
        schemaVersion: 1,
        event: 'SessionStart',
        runId: 'run_1',
        threadId: 'thread_1',
        workspacePath: null,
        cwd: '/workspace/project',
        triggeredAt: '2026-06-24T10:00:00.000Z',
        payload: { source: 'chat', modelId: 'model', workflowHint: null }
      }
    });

    if (result.status !== 'failed') {
      throw new Error('expected failed hook result');
    }
    expect(result.error).toBe('hook_cwd_virtual_path');
  });

  it('reports non-zero exit codes as failed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'roc-hooks-'));
    const result = await new HookCommandRunner().run({
      command: 'node -e "process.exit(7)"',
      cwd: dir,
      timeoutSeconds: 5,
      input: {
        schemaVersion: 1,
        event: 'SessionEnd',
        runId: 'run_1',
        threadId: 'thread_1',
        workspacePath: dir,
        cwd: dir,
        triggeredAt: '2026-06-24T10:00:00.000Z',
        payload: { status: 'completed', error: null }
      }
    });

    if (result.status !== 'failed') {
      throw new Error('expected failed hook result');
    }
    expect(result.error).toBe('hook_command_exit_7');
  });
});
