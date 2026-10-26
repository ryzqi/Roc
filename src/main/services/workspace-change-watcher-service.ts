import { watch as watchWorkspace } from 'node:fs';

import type { WorkspaceChangedEvent } from '../../shared/types';
import { hasIgnoredFileNameSearchParentDirectory } from './file-name-search-path-policy';

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
  /** Called synchronously for file changes and watcher failures so caches cannot outlive the debounce. */
  onInvalidate?: (workspacePath: string) => void;
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
  private watcherGeneration = 0;
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
    const generation = this.watcherGeneration;
    try {
      this.watcher = this.watch(workspacePath, { recursive: true }, (eventType, filename) => {
        this.handleFileSystemChange(workspacePath, generation, eventType, filename);
      });
      this.watcher.on('error', (error) => {
        this.handleWatcherError(workspacePath, generation, error);
      });
    } catch (error) {
      this.options.logger.warn('Workspace change watcher failed to start.', {
        workspacePath,
        error: error instanceof Error ? error.message : String(error)
      });
      this.invalidateSnapshot(workspacePath);
      this.closeWatcher();
      this.workspacePath = null;
    }
  }

  private handleWatcherError(workspacePath: string, generation: number, error: Error): void {
    if (this.workspacePath !== workspacePath || this.watcherGeneration !== generation) return;
    this.options.logger.warn('Workspace change watcher failed after start.', {
      workspacePath,
      error: error.message
    });
    this.closeWatcher();
    this.invalidateSnapshot(workspacePath);
    this.workspacePath = null;
  }

  shutdown(): void {
    this.closeWatcher();
    this.workspacePath = null;
  }

  private closeWatcher(): void {
    this.watcherGeneration += 1;
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

  private handleFileSystemChange(
    workspacePath: string,
    generation: number,
    eventType: string,
    filename: string | Buffer | null
  ): void {
    if (this.workspacePath !== workspacePath || this.watcherGeneration !== generation) {
      return;
    }
    const relativePath = normalizeWatchFilename(filename);
    if (relativePath === null || !hasIgnoredFileNameSearchParentDirectory(relativePath)) {
      this.invalidateSnapshot(workspacePath);
    }
    if (relativePath !== null && shouldIgnoreRelativePath(relativePath)) {
      return;
    }
    this.pendingEvent = {
      workspacePath,
      relativePath,
      eventType: eventType === 'rename' ? 'rename' : 'change'
    };
    this.schedulePublish();
  }

  private invalidateSnapshot(workspacePath: string): void {
    try {
      this.options.onInvalidate?.(workspacePath);
    } catch (error) {
      this.options.logger.warn('Workspace path snapshot invalidation failed.', {
        workspacePath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
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
  // Leading/trailing spaces are valid filename characters. Trimming could turn a
  // real root entry such as " node_modules" into an ignored directory name.
  return raw.length === 0 ? null : raw;
}

function shouldIgnoreRelativePath(relativePath: string): boolean {
  const firstSegment = relativePath.split('/')[0];
  if (firstSegment === undefined) {
    return false;
  }
  return ignoredTopLevelDirectories.has(firstSegment);
}
