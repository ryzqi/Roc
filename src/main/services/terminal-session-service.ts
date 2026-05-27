import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node-pty';
import type {
  TerminalSessionCloseRequest,
  TerminalSessionCreateRequest,
  TerminalSessionExitEvent,
  TerminalSessionInputRequest,
  TerminalSessionOutputEvent,
  TerminalSessionResizeRequest,
  TerminalSessionSnapshot
} from '../../shared/types';
import { RocDomainError } from './errors';
import type { RocPaths } from './paths';
import type { WorkspaceService } from './workspace-service';

type PtyInstance = ReturnType<typeof spawn>;

type SessionRecord = {
  pty: PtyInstance;
  snapshot: TerminalSessionSnapshot;
  logPath: string;
};

export class TerminalSessionService {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly events = new EventEmitter();

  constructor(
    private readonly paths: RocPaths,
    private readonly workspaceService: WorkspaceService
  ) {
    this.events.setMaxListeners(100);
  }

  createSession(request: TerminalSessionCreateRequest): TerminalSessionSnapshot {
    const cwd = request.cwd ?? this.workspaceService.requireWorkspace().path;
    if (!this.workspaceService.isPathInsideCurrentWorkspace(cwd)) {
      throw new RocDomainError({
        code: 'terminal_session_outside_workspace',
        message: '终端会话目录必须位于当前工作区内。',
        category: 'permission',
        retryable: false,
        userAction: '请选择当前工作区内的目录后重试。'
      });
    }

    const shell = this.resolveShell();
    const sessionId = randomUUID();
    const logPath = join(this.paths.terminalDir, 'logs', `${sessionId}.log`);
    mkdirSync(join(this.paths.terminalDir, 'logs'), { recursive: true });
    const pty = spawn(shell.file, shell.args, {
      name: 'xterm-color',
      cols: this.validCols(request.cols),
      rows: this.validRows(request.rows),
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color'
      }
    });
    const snapshot: TerminalSessionSnapshot = {
      id: sessionId,
      cwd,
      shell: shell.label,
      cols: this.validCols(request.cols),
      rows: this.validRows(request.rows),
      status: 'ready',
      exitCode: null
    };
    const record: SessionRecord = {
      pty,
      snapshot,
      logPath
    };

    pty.onData((data) => {
      appendFileSync(logPath, data, 'utf8');
      const payload: TerminalSessionOutputEvent = { sessionId, data };
      this.events.emit('output', payload);
    });
    pty.onExit(({ exitCode }) => {
      record.snapshot = {
        ...record.snapshot,
        status: 'exited',
        exitCode
      };
      const payload: TerminalSessionExitEvent = { sessionId, exitCode };
      this.events.emit('exit', payload);
      this.sessions.delete(sessionId);
    });

    this.sessions.set(sessionId, record);
    return snapshot;
  }

  writeInput(request: TerminalSessionInputRequest): { delivered: true } {
    const record = this.requireSession(request.sessionId);
    record.pty.write(request.data);
    return { delivered: true };
  }

  resize(request: TerminalSessionResizeRequest): TerminalSessionSnapshot {
    const record = this.requireSession(request.sessionId);
    const cols = this.validCols(request.cols);
    const rows = this.validRows(request.rows);
    record.pty.resize(cols, rows);
    record.snapshot = { ...record.snapshot, cols, rows };
    return record.snapshot;
  }

  closeSession(request: TerminalSessionCloseRequest): { closed: true } {
    const record = this.requireSession(request.sessionId);
    record.pty.kill();
    this.sessions.delete(request.sessionId);
    return { closed: true };
  }

  shutdown(): void {
    for (const [sessionId, record] of this.sessions.entries()) {
      record.pty.kill();
      this.sessions.delete(sessionId);
    }
  }

  onOutput(listener: (event: TerminalSessionOutputEvent) => void): () => void {
    this.events.on('output', listener);
    return () => this.events.off('output', listener);
  }

  onExit(listener: (event: TerminalSessionExitEvent) => void): () => void {
    this.events.on('exit', listener);
    return () => this.events.off('exit', listener);
  }

  private requireSession(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (record === undefined) {
      throw new RocDomainError({
        code: 'terminal_session_missing',
        message: '终端会话不存在或已经结束。',
        category: 'not_found',
        retryable: true,
        userAction: '请重新打开终端工作台，建立新的终端会话。'
      });
    }
    return record;
  }

  private resolveShell(): { file: string; args: string[]; label: string } {
    const pwsh = resolve('C:/Program Files/PowerShell/7/pwsh.exe');
    if (existsSync(pwsh)) {
      return {
        file: pwsh,
        args: ['-NoLogo'],
        label: 'pwsh'
      };
    }
    return {
      file: 'powershell.exe',
      args: ['-NoLogo'],
      label: 'powershell'
    };
  }

  private validCols(value: number): number {
    if (!Number.isFinite(value) || value < 20) {
      return 80;
    }
    return Math.round(value);
  }

  private validRows(value: number): number {
    if (!Number.isFinite(value) || value < 5) {
      return 24;
    }
    return Math.round(value);
  }
}
