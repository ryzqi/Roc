import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '../../src/main/services/config-service';
import { RocDomainError } from '../../src/main/services/errors';
import { RocPaths } from '../../src/main/services/paths';
import { TerminalSessionService } from '../../src/main/services/terminal-session-service';
import { WorkspaceService } from '../../src/main/services/workspace-service';

let root: string;
let workspaceRoot: string;
let outsideRoot: string;
let service: TerminalSessionService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-terminal-session-'));
  workspaceRoot = join(root, 'workspace');
  outsideRoot = mkdtempSync(join(tmpdir(), 'roc-terminal-session-outside-'));
  mkdirSync(workspaceRoot, { recursive: true });

  const paths = new RocPaths(root);
  paths.ensureTree();
  const configService = new ConfigService(paths);
  configService.initialize();
  const workspaceService = new WorkspaceService(configService);
  workspaceService.selectWorkspace(workspaceRoot);
  service = new TerminalSessionService(paths, workspaceService);
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 120));
  rmSync(root, { recursive: true, force: true });
  rmSync(outsideRoot, { recursive: true, force: true });
});

describe('terminal session service', () => {
  it('creates a terminal session inside the current workspace', () => {
    const exitEvent = new Promise<number | null>((resolve) => {
      const dispose = service.onExit((event) => {
        dispose();
        resolve(event.exitCode);
      });
    });
    const snapshot = service.createSession({
      cwd: workspaceRoot,
      cols: 100,
      rows: 30
    });

    expect(snapshot.cwd).toBe(workspaceRoot);
    expect(snapshot.status).toBe('ready');
    expect(snapshot.cols).toBe(100);
    expect(snapshot.rows).toBe(30);
    expect(snapshot.id.length).toBeGreaterThan(10);

    expect(service.closeSession({ sessionId: snapshot.id })).toEqual({ closed: true });
    return expect(exitEvent).resolves.not.toBeUndefined();
  });

  it('kills all active sessions during shutdown', async () => {
    const exitEvent = new Promise<number | null>((resolve) => {
      const dispose = service.onExit((event) => {
        dispose();
        resolve(event.exitCode);
      });
    });
    const snapshot = service.createSession({
      cwd: workspaceRoot,
      cols: 100,
      rows: 30
    });

    service.shutdown();

    await expect(exitEvent).resolves.not.toBeUndefined();
    expect(() => service.closeSession({ sessionId: snapshot.id })).toThrow(RocDomainError);
  });

  it('rejects terminal sessions outside the current workspace', () => {
    expect(() =>
      service.createSession({
        cwd: outsideRoot,
        cols: 80,
        rows: 24
      })
    ).toThrowError(RocDomainError);

    try {
      service.createSession({
        cwd: outsideRoot,
        cols: 80,
        rows: 24
      });
    } catch (error) {
      expect(error).toMatchObject({
        code: 'terminal_session_outside_workspace'
      });
    }
  });

  it('raises terminal_session_missing for write/resize/close against unknown sessions', () => {
    for (const operation of [
      () => service.writeInput({ sessionId: 'missing-session', data: 'dir\r' }),
      () => service.resize({ sessionId: 'missing-session', cols: 120, rows: 40 }),
      () => service.closeSession({ sessionId: 'missing-session' })
    ]) {
      try {
        operation();
        throw new Error('expected terminal_session_missing');
      } catch (error) {
        expect(error).toMatchObject({
          code: 'terminal_session_missing'
        });
      }
    }
  });
});
