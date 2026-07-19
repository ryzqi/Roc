import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('stops a running hook when its signal is aborted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'roc-hooks-'));
    const controller = new AbortController();
    const execution = new HookCommandRunner().run({
      command: 'node -e "setTimeout(() => process.stdout.write(\\\"{\\\\\"action\\\\\":\\\\\"continue\\\\\"}\\\"), 30000)"',
      cwd: dir,
      timeoutSeconds: 30,
      signal: controller.signal,
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

    controller.abort();

    await expect(execution).resolves.toMatchObject({ status: 'failed', error: 'hook_command_aborted' });
  });

  it('does not spawn a hook when its signal is already aborted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'roc-hooks-'));
    const controller = new AbortController();
    controller.abort();

    const result = await new HookCommandRunner().run({
      command: 'node -e "process.exit(7)"',
      cwd: dir,
      timeoutSeconds: 5,
      signal: controller.signal,
      input: {
        schemaVersion: 1,
        event: 'SessionEnd',
        runId: 'run_1',
        threadId: 'thread_1',
        workspacePath: dir,
        cwd: dir,
        triggeredAt: '2026-06-24T10:00:00.000Z',
        payload: { status: 'cancelled', error: null }
      }
    });

    expect(result).toMatchObject({ status: 'failed', error: 'hook_command_aborted', durationMs: 0 });
  });

  it.skipIf(process.platform !== 'win32')('terminates a Windows hook child tree when its signal is aborted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'roc-hooks-'));
    const pidPath = join(dir, 'child.pid');
    const scriptPath = join(dir, 'hook.cjs');
    writeFileSync(
      scriptPath,
      [
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        `const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });`,
        `writeFileSync(${JSON.stringify(pidPath)}, String(child.pid), 'utf8');`,
        'child.once(\'exit\', () => process.exit(0));'
      ].join('\n'),
      'utf8'
    );
    const controller = new AbortController();
    const execution = new HookCommandRunner().run({
      command: `node "${scriptPath}"`,
      cwd: process.cwd(),
      timeoutSeconds: 30,
      signal: controller.signal,
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

    try {
      await waitUntil(() => existsSync(pidPath));
      const childPid = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
      controller.abort();
      await expect(execution).resolves.toMatchObject({ status: 'failed', error: 'hook_command_aborted' });
      await waitUntil(() => !isProcessRunning(childPid));
      expect(isProcessRunning(childPid)).toBe(false);
    } finally {
      controller.abort();
      await execution.catch(() => undefined);
      if (existsSync(pidPath)) {
        const childPid = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
        if (isProcessRunning(childPid)) {
          execFileSync('taskkill.exe', ['/PID', String(childPid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('hook_cancellation_barrier_timeout');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
