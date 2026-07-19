import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultSettings } from '../../../src/main/services/config/defaults';
import type { RtkService } from '../../../src/main/services/rtk-service';
import { ShellExecutionService } from '../../../src/main/services/shell-execution-service';
import { WorkspaceService } from '../../../src/main/services/workspace-service';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-shell-cancel-'));
});

afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

describe.skipIf(process.platform !== 'win32')('ShellExecutionService cancellation', () => {
  it('removes secret environment values from agent commands', async () => {
    const service = createService();
    process.env.ROC_SHELL_SECRET_TEST = 'must-not-leak';
    try {
      const result = await service.executeAsync({
        command: "if (Test-Path Env:ROC_SHELL_SECRET_TEST) { Write-Output leaked } else { Write-Output clean }",
        cwd: root,
        source: 'agent'
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('clean');
    } finally {
      delete process.env.ROC_SHELL_SECRET_TEST;
    }
  });

  it('terminates the full Windows child process tree when the run is aborted', async () => {
    const service = createService();
    const pidPath = join(root, 'child.pid');
    const escapedPidPath = pidPath.replaceAll("'", "''");
    const controller = new AbortController();
    const execution = service.executeAsync({
      command: [
        "$child = Start-Process powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 30' -PassThru",
        `Set-Content -LiteralPath '${escapedPidPath}' -Value $child.Id`,
        'Wait-Process -Id $child.Id'
      ].join('; '),
      cwd: root,
      source: 'agent',
      signal: controller.signal
    });
    let childPid: number | null = null;
    try {
      childPid = await waitForChildPid(pidPath);
      controller.abort(new Error('test_abort'));
      await expect(execution).rejects.toThrow('shell_execution_aborted');
      await waitForProcessExit(childPid);
      expect(isProcessRunning(childPid)).toBe(false);
    } finally {
      controller.abort(new Error('test_cleanup'));
      await execution.catch(() => undefined);
      if (childPid !== null && isProcessRunning(childPid)) {
        execFileSync('taskkill.exe', ['/PID', String(childPid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      }
    }
  }, 15_000);
});

function createService(): ShellExecutionService {
  const workspaceService = new WorkspaceService({
    getSettings: () => ({ ...defaultSettings, defaultWorkspace: root }),
    saveSettings: () => {}
  });
  const rtkService = {
    getExecutionMetadata: () => ({
      binaryPath: join(root, 'missing-rtk.exe'),
      runtimeRoot: root,
      configPath: join(root, 'rtk', 'config.toml'),
      teeDir: join(root, 'rtk', 'tee'),
      trackingDatabasePath: join(root, 'rtk', 'history.db'),
      resourceState: 'missing' as const,
      bypassReason: 'rtk_binary_missing' as const
    })
  } as RtkService;
  return new ShellExecutionService(workspaceService, rtkService, { recordEvent: () => undefined });
}

async function waitForChildPid(pidPath: string): Promise<number> {
  let pid: number | null = null;
  await waitUntil(() => {
    if (!existsSync(pidPath)) {
      return false;
    }
    try {
      const parsed = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return false;
      }
      pid = parsed;
      return true;
    } catch {
      return false;
    }
  });
  const validPid = pid;
  if (validPid === null || !Number.isInteger(validPid) || validPid <= 0) {
    throw new Error('shell_cancellation_child_pid_invalid');
  }
  return validPid;
}

async function waitForProcessExit(pid: number): Promise<void> {
  try {
    await waitUntil(() => !isProcessRunning(pid));
  } finally {
    if (isProcessRunning(pid)) {
      execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    }
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('shell_cancellation_barrier_timeout');
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
