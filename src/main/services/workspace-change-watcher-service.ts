import { watch as watchWorkspace } from 'node:fs';
import type { FSWatcher } from 'node:fs';

import type { WorkspaceChangedEvent } from '../../shared/types';

type WorkspaceWatchHandle = {
  close(): void;
  on(event: 'error', listener: (error: Error) => void): void;
};

type WorkspaceWatchFactory = (
  path: string,
  options: { recursive: true },
  listener: (eventType: string, filename: string | Buffer | null) => void
) => WorkspaceWatchHandle;

type WorkspaceChangeWatcherLogger = {
  warn(message: string, metadata?: Record<string, unknown>): void;
};

type WorkspaceChangeWatcherOptions = {
  debounceMs?: number;
  logger: WorkspaceChangeWatcherLogger;
  onChange: (event: WorkspaceChangedEvent) => Promise<void> | void;
  watch?: WorkspaceWatchFactory;
};

const defaultDebounceMs = 150;
const ignoredTopLevelDirectories = new Set([
  'node_modules',
  'dist',
  'out',
  'release',
  'coverage',
  '.cache',
  '.tmp',
  '.runtime',
  '.artifacts'
]);

export class WorkspaceChangeWatcherService {
  private readonly debounceMs: number;
  private readonly watch: WorkspaceWatchFactory;
  private watcher: WorkspaceWatchHandle | null = null;
  private workspacePath: string | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingEvent: WorkspaceChangedEvent | null = null;

  constructor(private readonly options: WorkspaceChangeWatcherOptions) {
    this.debounceMs = options.debounceMs === undefined ? defaultDebounceMs : options.debounceMs;
    this.watch = options.watch === undefined ? watchWorkspace : options.watch;
  }

  setWorkspace(workspacePath: string | null): void {
    if (this.workspacePath === workspacePath) {
      return;
    }
    this.closeWatcher();
    this.workspacePath = workspacePath;
    if (workspacePath === null) {
      return;
    }
    try {
      this.watcher = this.watch(workspacePath, { recursive: true }, (eventType, filename) => {
        this.handleFileSystemChange(eventType, filename);
      });
      this.watcher.on('error', (error) => {
        this.handleWatcherError(error);
      });
    } catch (error) {
      this.options.logger.warn('Workspace change watcher failed to start.', {
        workspacePath,
        error: error instanceof Error ? error.message : String(error)
      });
      this.workspacePath = null;
    }
  }

  private handleWatcherError(error: Error): void {
    const workspacePath = this.workspacePath;
    this.options.logger.warn('Workspace change watcher failed after start.', {
      workspacePath,
      error: error.message
    });
    this.closeWatcher();
    this.workspacePath = null;
  }

  shutdown(): void {
    this.closeWatcher();
    this.workspacePath = null;
  }

  private closeWatcher(): void {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.pendingEvent = null;
    if (this.watcher !== null) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private handleFileSystemChange(eventType: string, filename: string | Buffer | null): void {
    if (this.workspacePath === null) {
      return;
    }
    const relativePath = normalizeWatchFilename(filename);
    if (relativePath !== null && shouldIgnoreRelativePath(relativePath)) {
      return;
    }
    this.pendingEvent = {
      workspacePath: this.workspacePath,
      relativePath,
      eventType: eventType === 'rename' ? 'rename' : 'change'
    };
    this.schedulePublish();
  }

  private schedulePublish(): void {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.publishPendingEvent();
    }, this.debounceMs);
  }

  private async publishPendingEvent(): Promise<void> {
    const event = this.pendingEvent;
    this.pendingEvent = null;
    if (event === null) {
      return;
    }
    try {
      await this.options.onChange(event);
    } catch (error) {
      this.options.logger.warn('Workspace change event publish failed.', {
        workspacePath: event.workspacePath,
        relativePath: event.relativePath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

function normalizeWatchFilename(filename: string | Buffer | null): string | null {
  if (filename === null) {
    return null;
  }
  const raw = Buffer.isBuffer(filename) ? filename.toString('utf8') : filename;
  const normalized = raw.trim().replaceAll('\\', '/');
  return normalized.length === 0 ? null : normalized;
}

function shouldIgnoreRelativePath(relativePath: string): boolean {
  const firstSegment = relativePath.split('/')[0];
  if (firstSegment === undefined) {
    return false;
  }
  return ignoredTopLevelDirectories.has(firstSegment);
}
