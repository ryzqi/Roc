import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { EventEmitter } from 'node:events';
import { spawn } from 'node-pty';
import type {
  TerminalSessionAttachment,
  TerminalSessionAttachRequest,
  TerminalSessionDetachRequest,
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
import {terminalOwner} from './terminal-owner-context';

type PtyInstance = ReturnType<typeof spawn>;

export const TERMINAL_REPLAY_LIMIT = 256 * 1024;
const MAX_OWNER_SESSIONS = 16;

type SessionRecord = {
  owner: number;
  projectId: string | null;
  workspacePath: string;
  attachmentId: string | null;
  attached: boolean;
  sequence: number;
  output: string;
  logStream: WriteStream;
  logStreamClosed: boolean;
  pausedForLog: boolean;
  pty: PtyInstance;
  snapshot: TerminalSessionSnapshot;
};

export class TerminalSessionService {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly events = new EventEmitter();

  constructor(
    private readonly paths: RocPaths,
    private readonly workspaceService: WorkspaceService,
    private readonly validateProject: (projectId: string | null, workspacePath: string) => void = () => {}
  ) {
    this.events.setMaxListeners(100);
  }

  createSession(request: TerminalSessionCreateRequest): TerminalSessionSnapshot {
    const workspacePath = this.workspaceService.requireWorkspace().path;
    const cwd = resolve(request.cwd ?? workspacePath);
    this.validateProject(request.projectId ?? null, workspacePath);
    if ([...this.sessions.values()].filter(record => record.owner === terminalOwner()).length >= MAX_OWNER_SESSIONS) {
      throw new RocDomainError({code:'terminal_session_limit', message:'此窗口的终端会话已达 16 个，请先结束不再使用的会话。', category:'validation', retryable:true});
    }
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
    const logStream = createWriteStream(logPath, { flags: 'a', encoding: 'utf8' });
    let record: SessionRecord | undefined;
    const resumeAfterLog = (): void => {
      if (record?.pausedForLog && this.sessions.get(sessionId) === record) {
        record.pausedForLog = false;
        record.pty.resume();
      }
    };
    const stopLogging = (): void => {
      if (record !== undefined) record.logStreamClosed = true;
      resumeAfterLog();
    };
    // Install before spawning: opening the file can fail asynchronously even
    // when spawn throws and the session never enters the registry.
    logStream.on('error', stopLogging);
    logStream.on('close', stopLogging);
    logStream.on('drain', resumeAfterLog);
    let pty: PtyInstance;
    try {
      pty = spawn(shell.file, shell.args, {
        name: 'xterm-256color',
        cols: this.validCols(request.cols),
        rows: this.validRows(request.rows),
        cwd,
        env: {
          ...process.env,
          TERM: 'xterm-256color'
        }
      });
    } catch (error) {
      logStream.destroy();
      throw error;
    }
    const snapshot: TerminalSessionSnapshot = {
      id: sessionId,
      cwd,
      shell: shell.label,
      cols: this.validCols(request.cols),
      rows: this.validRows(request.rows),
      status: 'ready',
      exitCode: null
    };
    const sessionRecord: SessionRecord = {
      owner: terminalOwner(), projectId: request.projectId ?? null, workspacePath,
      attachmentId: null, attached: true, sequence: 0, output: '',
      logStream,
      logStreamClosed: false,
      pausedForLog: false,
      pty,
      snapshot
    };
    record = sessionRecord;

    pty.onData((data) => {
      const activeRecord = this.sessions.get(sessionId);
      if (activeRecord === undefined) {
        return;
      }
      if (!activeRecord.logStreamClosed) {
        if (!activeRecord.logStream.write(data, 'utf8') && !activeRecord.pausedForLog) {
          activeRecord.pausedForLog = true;
          activeRecord.pty.pause();
        }
      }
      const startSequence = activeRecord.sequence;
      activeRecord.sequence += data.length;
      activeRecord.output = (activeRecord.output + data).slice(-TERMINAL_REPLAY_LIMIT);
      // A replay never starts inside a UTF-16 surrogate pair.
      if (/^[\uDC00-\uDFFF]/u.test(activeRecord.output)) activeRecord.output = activeRecord.output.slice(1);
      if (activeRecord.attached) {
        const payload: TerminalSessionOutputEvent = { sessionId, ownerId: activeRecord.owner, attachmentId: activeRecord.attachmentId,
          startSequence, sequence: activeRecord.sequence, data };
        this.events.emit('output', payload);
      }
    });
    pty.onExit(({ exitCode }) => {
      if (this.sessions.get(sessionId) !== sessionRecord) return;
      sessionRecord.snapshot = {
        ...sessionRecord.snapshot,
        status: 'exited',
        exitCode
      };
      const payload: TerminalSessionExitEvent = { sessionId, ownerId: sessionRecord.owner, attachmentId: sessionRecord.attachmentId, exitCode };
      if (sessionRecord.attached) this.events.emit('exit', payload);
      this.closeLogStream(sessionRecord);
    });

    this.sessions.set(sessionId, sessionRecord);
    return snapshot;
  }

  attachSession(request: TerminalSessionAttachRequest): TerminalSessionAttachment {
    const workspacePath = this.workspaceService.requireWorkspace().path;
    const cwd = resolve(request.cwd ?? workspacePath);
    this.validateProject(request.projectId ?? null, workspacePath);
    let record = request.sessionId === undefined ? [...this.sessions.values()].find(value =>
      value.owner === terminalOwner() && value.projectId === (request.projectId ?? null) &&
      value.workspacePath === workspacePath && value.snapshot.cwd === cwd
    ) : this.requireSession({...request, sessionId: request.sessionId}, true, false);
    if (record !== undefined && record.snapshot.cwd !== cwd) throw new RocDomainError({code:'terminal_session_scope_mismatch', message:'终端连接已变更，请重新连接当前项目的终端。', category:'permission', retryable:true});
    if (record === undefined) record = this.sessions.get(this.createSession(request).id)!;
    record.attachmentId = randomUUID();
    record.attached = true;
    if (record.snapshot.status === 'ready') {
      const cols = this.validCols(request.cols), rows = this.validRows(request.rows);
      record.pty.resize(cols, rows);
      record.snapshot = {...record.snapshot, cols, rows};
    }
    // Truncated raw streams can begin inside an ANSI control sequence. Resume
    // only after a complete line and reset the fresh emulator before replay.
    const truncated = record.sequence > record.output.length;
    let data = record.output;
    if (truncated) {
      const line = data.indexOf('\n');
      data = line < 0 ? '' : data.slice(line + 1);
    }
    return {session: record.snapshot, attachmentId: record.attachmentId,
      replay: {startSequence: record.sequence - data.length, sequence: record.sequence, data, truncated}};
  }

  detachSession(request: TerminalSessionDetachRequest): {closed: true} {
    const record = this.requireSession(request, false, false);
    // Cleanup from an older view can arrive after a replacement has attached.
    if (record.attachmentId === request.attachmentId) record.attached = false;
    return {closed: true};
  }

  writeInput(request: TerminalSessionInputRequest): { delivered: true } {
    const record = this.requireSession(request, true);
    if (record.snapshot.status !== 'ready' || !record.attached) throw new RocDomainError({code:'terminal_session_not_ready', message:'终端会话已经退出或当前显示已断开。', category:'validation', retryable:true});
    record.pty.write(request.data);
    return { delivered: true };
  }

  resize(request: TerminalSessionResizeRequest): TerminalSessionSnapshot {
    const record = this.requireSession(request, true);
    const cols = this.validCols(request.cols), rows = this.validRows(request.rows);
    if (record.snapshot.status === 'ready') record.pty.resize(cols, rows);
    record.snapshot = { ...record.snapshot, cols, rows };
    return record.snapshot;
  }

  closeSession(request: TerminalSessionCloseRequest): { closed: true } {
    this.release(this.requireSession(request, false));
    return { closed: true };
  }

  closeOwner(owner: number): void {
    for (const record of this.sessions.values()) if (record.owner === owner) this.release(record);
  }

  shutdown(): void {
    for (const record of this.sessions.values()) this.release(record);
  }

  private release(record: SessionRecord): void {
    this.sessions.delete(record.snapshot.id);
    this.closeLogStream(record);
    if (record.snapshot.status === 'ready') record.pty.kill();
  }

  onOutput(listener: (event: TerminalSessionOutputEvent) => void): () => void {
    this.events.on('output', listener);
    return () => this.events.off('output', listener);
  }

  onExit(listener: (event: TerminalSessionExitEvent) => void): () => void {
    this.events.on('exit', listener);
    return () => this.events.off('exit', listener);
  }

  private requireSession(request: TerminalSessionCloseRequest, currentWorkspace: boolean, checkAttachment = true): SessionRecord {
    const record = this.sessions.get(request.sessionId);
    if (record === undefined) {
      throw new RocDomainError({
        code: 'terminal_session_missing',
        message: '终端会话不存在或已经结束。',
        category: 'not_found',
        retryable: true,
        userAction: '请重新打开终端工作台，建立新的终端会话。'
      });
    }
    if (record.owner !== terminalOwner() || record.projectId !== (request.projectId ?? null) ||
      (currentWorkspace && record.workspacePath !== this.workspaceService.requireWorkspace().path) ||
      (checkAttachment && record.attachmentId !== null && record.attachmentId !== request.attachmentId)) {
      throw new RocDomainError({code:'terminal_session_scope_mismatch', message:'终端连接已变更，请重新连接当前项目的终端。', category:'permission', retryable:true});
    }
    if (currentWorkspace) this.validateProject(record.projectId, record.workspacePath);
    return record;
  }

  private closeLogStream(record: SessionRecord): void {
    // A late drain/close must never resume a terminal being disposed.
    record.pausedForLog = false;
    if (record.logStreamClosed) {
      return;
    }
    record.logStreamClosed = true;
    record.logStream.end();
  }

  private resolveShell(): { file: string; args: string[]; label: string } {
    const file = process.env.SHELL || userInfo().shell || '/bin/zsh';
    return { file, args: ['-l'], label: basename(file) };
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
