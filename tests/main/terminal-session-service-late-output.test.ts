import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let onDataHandler: ((data: string) => void) | null = null;
let onExitHandler: ((event: { exitCode: number }) => void) | null = null;

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    kill: vi.fn(() => {
      if (onExitHandler !== null) {
        onExitHandler({ exitCode: 0 });
      }
    }),
    onData: vi.fn((handler: (data: string) => void) => {
      onDataHandler = handler;
    }),
    onExit: vi.fn((handler: (event: { exitCode: number }) => void) => {
      onExitHandler = handler;
    }),
    resize: vi.fn(),
    write: vi.fn()
  }))
}));

const { ConfigService } = await import('../../src/main/services/config-service');
const { RocPaths } = await import('../../src/main/services/paths');
const { TerminalSessionService } = await import('../../src/main/services/terminal-session-service');
const { WorkspaceService } = await import('../../src/main/services/workspace-service');

let root: string;
let workspaceRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-terminal-late-output-'));
  workspaceRoot = join(root, 'workspace');
  mkdirSync(workspaceRoot, { recursive: true });
  onDataHandler = null;
  onExitHandler = null;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('terminal session service late output handling', () => {
  it('ignores PTY output that arrives after a session is closed', () => {
    const paths = new RocPaths(root);
    paths.ensureTree();
    const configService = new ConfigService(paths);
    configService.initialize();
    const workspaceService = new WorkspaceService(configService);
    workspaceService.selectWorkspace(workspaceRoot);
    const service = new TerminalSessionService(paths, workspaceService);
    const session = service.createSession({
      cwd: workspaceRoot,
      cols: 80,
      rows: 24
    });

    service.closeSession({ sessionId: session.id });
    rmSync(join(paths.terminalDir, 'logs'), { recursive: true, force: true });

    expect(() => onDataHandler?.('late output')).not.toThrow();
  });
});
