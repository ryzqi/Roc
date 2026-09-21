import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '../../../src/main/services/config/defaults';
import type { RtkService } from '../../../src/main/services/rtk-service';
import { ShellExecutionService } from '../../../src/main/services/shell-execution-service';
import { WorkspaceService } from '../../../src/main/services/workspace-service';

let root: string;
let workspaceRoot: string;
let workspace: WorkspaceService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-mac-runtime-'));
  workspaceRoot = join(root, 'workspace');
  mkdirSync(join(workspaceRoot, 'nested'), { recursive: true });
  workspace = new WorkspaceService({
    getSettings: () => defaultSettings,
    saveSettings: vi.fn()
  });
  workspace.selectWorkspace(workspaceRoot);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('platform workspace paths', () => {
  it('accepts nested files and dot-prefixed names using native path boundaries', () => {
    expect(workspace.resolveInsideWorkspace('nested/file.txt')).toBe(join(workspaceRoot, 'nested', 'file.txt'));
    expect(workspace.resolveInsideWorkspace('..notes.txt')).toBe(join(workspaceRoot, '..notes.txt'));
    expect(workspace.isPathInsideCurrentWorkspace(workspaceRoot)).toBe(true);
  });

  it('rejects parent traversal and sibling directories sharing the root prefix', () => {
    expect(() => workspace.resolveInsideWorkspace('../outside.txt')).toThrow();
    expect(workspace.isPathInsideCurrentWorkspace(`${workspaceRoot}-other/file.txt`)).toBe(false);
  });

  it('rejects symlink escapes while accepting real nested files', () => {
    const inside = join(workspaceRoot, 'nested', 'file.txt');
    const outside = join(root, 'outside.txt');
    writeFileSync(inside, 'inside');
    writeFileSync(outside, 'outside');
    symlinkSync(outside, join(workspaceRoot, 'escape.txt'));
    expect(() => workspace.assertRealPathInsideWorkspace(inside)).not.toThrow();
    expect(() => workspace.assertRealPathInsideWorkspace(join(workspaceRoot, 'escape.txt'))).toThrow();
  });
});

describe('POSIX shell execution', () => {
  function createShell() {
    const rtk = {
      getExecutionMetadata: () => ({ teeDir: join(root, 'tee') })
    } as RtkService;
    return new ShellExecutionService(workspace, rtk, { recordEvent: vi.fn() });
  }

  it('runs a terminal command synchronously with the native shell', () => {
    const result = createShell().execute({ command: "printf 'ROC_SHELL_OK'", cwd: workspaceRoot, source: 'terminal' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ROC_SHELL_OK');
  });

  it('runs a terminal command asynchronously and preserves nonzero exit status', async () => {
    const result = await createShell().executeAsync({ command: "printf 'ROC_ASYNC_OK'; exit 7", cwd: workspaceRoot, source: 'terminal' });
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe('ROC_ASYNC_OK');
  });
});
