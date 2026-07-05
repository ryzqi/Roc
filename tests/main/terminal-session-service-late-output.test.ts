import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  it('writes active PTY output to the session log and emits the output event', async () => {
    const paths = new RocPaths(root);
    paths.ensureTree();
    const configService = new ConfigService(paths);
    configService.initialize();
    const workspaceService = new WorkspaceService(configService);
    workspaceService.selectWorkspace(workspaceRoot);
    const service = new TerminalSessionService(paths, workspaceService);
    const outputEvents: string[] = [];
    const dispose = service.onOutput((event) => {
      outputEvents.push(event.data);
    });
    const session = service.createSession({
      cwd: workspaceRoot,
      cols: 80,
      rows: 24
    });
    if (onDataHandler === null) {
      throw new Error('on_data_handler_missing');
    }

    onDataHandler('active output');

    expect(outputEvents).toEqual(['active output']);
    await waitFor(() => readFileSync(join(paths.terminalDir, 'logs', `${session.id}.log`), 'utf8') === 'active output');
    dispose();
    service.closeSession({ sessionId: session.id });
  });

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

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      if (predicate()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (lastError !== null) {
    throw lastError;
  }
  expect(predicate()).toBe(true);
}
