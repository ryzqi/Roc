import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  BuiltinSkillSourceStatus,
  BuiltinSkillsCheckRequest,
  BuiltinSkillsCheckResult,
  BuiltinSkillsStatus
} from '../../../shared/types';
import {
  builtinSkillsArchiveFilter,
  builtinSkillsArchiveUrl,
  builtinSkillsCommitUrl,
  defaultBuiltinSkillSources,
  readBuiltinSkillsCatalog,
  type BuiltinSkillSourceSpec
} from './catalog';
import { extractTarGz } from './archive';
import {
  discoverSkillIds,
  installBuiltinSnapshot,
  materializeSnapshot,
  readManagedSkillIds
} from './snapshot';

/**
 * Built-in skill sync.
 *
 * ## What "built in" means
 *
 * The installed app carries a snapshot of each upstream repository under
 * `resources/builtin-skills/<sourceId>/` (`skills/<id>/…`, `support/<dir>/…`, `source.json`).
 * On first launch the snapshot is installed into `~/.roc/skills` so the skills work offline and
 * before any network request happens. After that the service compares the snapshot/installation
 * commit with the upstream commit once a day (and on demand) and installs a fresh snapshot when
 * upstream moved.
 *
 * ## Why the state file is separate from the skill directories
 *
 * `~/.roc/skills/<id>/roc.skill.json` belongs to the skill (enable toggle + provenance). The
 * source-level facts — which upstream commit is installed, when it was last checked, whether the
 * user accepted a non-commercial license — live in `~/.roc/config/builtin-skills.json`, because
 * they outlive any single skill directory and must survive a skill being deleted or renamed.
 *
 * ## License boundary
 *
 * `autoInstall: false` sources (currently CC BY-NC 4.0) are bundled but never installed
 * automatically; `restore` is the explicit user action that records acceptance. Automatic daily
 * sync only touches sources that were already installed, so it cannot silently pull
 * non-commercial content into a Roc installation that never asked for it.
 */

const stateSchemaVersion = 1;
const defaultCheckIntervalMs = 24 * 60 * 60 * 1000;
const initialCheckDelayMs = 30 * 1000;
const requestTimeoutMs = 60 * 1000;
const archiveTimeoutMs = 5 * 60 * 1000;
const userAgent = 'roc-desktop-builtin-skills';

export type BuiltinSkillsLogger = {
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
};

type SourceState = {
  installedCommit: string | null;
  installedAt: string | null;
  installedSkillIds: string[];
  lastCheckedAt: string | null;
  etag: string | null;
  lastError: string | null;
  bundledCommitSeen: string | null;
  licenseAcceptedAt: string | null;
};

type BuiltinSkillsState = {
  schemaVersion: typeof stateSchemaVersion;
  autoUpdate: boolean;
  lastCheckedAt: string | null;
  sources: Record<string, SourceState>;
};

export type BuiltinSkillsServiceOptions = {
  skillsDir: string;
  statePath: string;
  bundledRoot: string;
  logger: BuiltinSkillsLogger;
  intervalMs?: number;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  onUpdated?: (status: BuiltinSkillsStatus) => void;
};

export class BuiltinSkillsService {
  private state: BuiltinSkillsState;
  private readonly specs: readonly BuiltinSkillSourceSpec[];
  private updating = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly options: BuiltinSkillsServiceOptions) {
    this.specs = readBundledSpecs(options.bundledRoot) ?? defaultBuiltinSkillSources;
    this.state = loadState(options.statePath);
  }

  /** Installs the bundled snapshot where needed, before the first `skills.list`. */
  async ensureInstalled(): Promise<void> {
    for (const spec of this.specs) {
      const sourceState = this.sourceState(spec.id);
      const bundledCommit = this.bundledCommit(spec);
      if (bundledCommit === null) {
        this.recordError(spec, 'builtin_skills_snapshot_missing');
        continue;
      }
      const needsLicenseAcceptance = !spec.autoInstall && sourceState.licenseAcceptedAt === null;
      if (needsLicenseAcceptance) {
        continue;
      }
      const bundleChanged = sourceState.bundledCommitSeen !== bundledCommit;
      const installed = sourceState.installedCommit;
      if (!bundleChanged && installed !== null) {
        continue;
      }
      await this.installFromBundle(spec, bundledCommit);
    }
    this.persist();
  }

  status(): BuiltinSkillsStatus {
    return {
      schemaVersion: 1,
      autoUpdate: this.state.autoUpdate,
      updating: this.updating,
      lastCheckedAt: this.state.lastCheckedAt,
      sources: this.specs.map((spec) => this.sourceStatus(spec))
    };
  }

  setAutoUpdate(autoUpdate: boolean): BuiltinSkillsStatus {
    this.state.autoUpdate = autoUpdate;
    this.persist();
    if (autoUpdate) {
      this.scheduleDailyCheck();
    } else {
      this.clearTimer();
    }
    return this.status();
  }

  /** Starts the daily timer; the first check only runs when the last one is older than a day. */
  start(): void {
    if (this.stopped || this.initialTimer !== null) {
      return;
    }
    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      if (!this.state.autoUpdate || !this.isCheckDue()) {
        return;
      }
      void this.runCheck({ force: false }).catch((error: unknown) => {
        this.options.logger.warn('Built-in skills initial check failed.', toLogMetadata(error));
      });
    }, initialCheckDelayMs);
    this.initialTimer.unref?.();
    this.scheduleDailyCheck();
  }

  shutdown(): void {
    this.stopped = true;
    this.clearTimer();
  }

  isUpdating(): boolean {
    return this.updating;
  }

  async check(request: BuiltinSkillsCheckRequest = {}): Promise<BuiltinSkillsCheckResult> {
    return await this.runCheck({ force: request.force === true });
  }

  /** Installs the bundled snapshot for one source (the explicit consent path for licensed content). */
  async restore(sourceId: string): Promise<BuiltinSkillsStatus> {
    const spec = this.specs.find((entry) => entry.id === sourceId);
    if (spec === undefined) {
      throw new Error(`builtin_skills_source_unknown:${sourceId}`);
    }
    const bundledCommit = this.bundledCommit(spec);
    if (bundledCommit === null) {
      throw new Error(`builtin_skills_snapshot_missing:${sourceId}`);
    }
    const sourceState = this.sourceState(spec.id);
    sourceState.licenseAcceptedAt = new Date().toISOString();
    await this.installFromBundle(spec, bundledCommit);
    this.persist();
    this.emitUpdated();
    return this.status();
  }

  private async runCheck(input: { force: boolean }): Promise<BuiltinSkillsCheckResult> {
    if (this.updating) {
      return { ...this.status(), changed: false, errors: ['builtin_skills_update_in_progress'] };
    }
    this.updating = true;
    this.emitUpdated();
    const errors: string[] = [];
    let changed = false;
    try {
      this.state.lastCheckedAt = new Date().toISOString();
      for (const spec of this.specs) {
        const sourceState = this.sourceState(spec.id);
        const installedOrAuto = sourceState.installedCommit !== null || spec.autoInstall;
        if (!installedOrAuto) {
          continue;
        }
        try {
          const result = await this.checkSource(spec, input.force);
          changed = changed || result;
        } catch (error) {
          const message = errorMessage(error);
          errors.push(`${spec.id}: ${message}`);
          sourceState.lastError = message;
          this.options.logger.warn('Built-in skills update failed.', { source: spec.id, error: message });
        }
        sourceState.lastCheckedAt = new Date().toISOString();
      }
      this.persist();
    } finally {
      this.updating = false;
      this.emitUpdated();
    }
    return { ...this.status(), changed, errors };
  }

  private async checkSource(spec: BuiltinSkillSourceSpec, force: boolean): Promise<boolean> {
    const sourceState = this.sourceState(spec.id);
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': userAgent
    };
    if (!force && sourceState.etag !== null) {
      headers['If-None-Match'] = sourceState.etag;
    }
    const response = await this.fetchImpl()(builtinSkillsCommitUrl(spec), {
      headers,
      signal: AbortSignal.timeout(requestTimeoutMs)
    });
    if (response.status === 304) {
      sourceState.lastError = null;
      return false;
    }
    if (!response.ok) {
      throw new Error(`github_commit_request_failed:${response.status}`);
    }
    const etag = response.headers.get('etag');
    if (etag !== null) {
      sourceState.etag = etag;
    }
    const payload = (await response.json()) as { sha?: unknown };
    const commit = typeof payload.sha === 'string' ? payload.sha : null;
    if (commit === null) {
      throw new Error('github_commit_response_invalid');
    }
    if (commit === sourceState.installedCommit) {
      sourceState.lastError = null;
      return false;
    }
    const bundledCommit = this.bundledCommit(spec);
    if (bundledCommit === commit) {
      await this.installFromBundle(spec, bundledCommit);
      return true;
    }
    await this.installFromRemote(spec, commit);
    return true;
  }

  private async installFromRemote(spec: BuiltinSkillSourceSpec, commit: string): Promise<void> {
    const tempRoot = join(this.options.skillsDir, `.builtin-download-${spec.id}-${process.pid}-${Date.now()}`);
    rmSync(tempRoot, { recursive: true, force: true });
    mkdirSync(tempRoot, { recursive: true });
    try {
      const response = await this.fetchImpl()(builtinSkillsArchiveUrl(spec), {
        headers: { 'User-Agent': userAgent },
        signal: AbortSignal.timeout(archiveTimeoutMs)
      });
      if (!response.ok) {
        throw new Error(`github_archive_request_failed:${response.status}`);
      }
      const archive = Buffer.from(await response.arrayBuffer());
      const repoRoot = join(tempRoot, 'repo');
      await extractTarGz(archive, repoRoot, {
        filter: builtinSkillsArchiveFilter(spec),
        stripTopLevel: true
      });
      const skillIds = discoverSkillIds(repoRoot, spec);
      if (skillIds.length === 0) {
        throw new Error('builtin_skills_upstream_layout_changed');
      }
      const snapshotDir = join(tempRoot, 'snapshot');
      materializeSnapshot({ repoRoot, spec, skillIds, outDir: snapshotDir, commit });
      const result = installBuiltinSnapshot({
        skillsDir: this.options.skillsDir,
        snapshotDir,
        spec,
        commit
      });
      const sourceState = this.sourceState(spec.id);
      sourceState.installedCommit = commit;
      sourceState.installedAt = new Date().toISOString();
      sourceState.installedSkillIds = result.installedSkillIds;
      sourceState.lastError = null;
      this.options.logger.info('Built-in skills updated from upstream.', {
        source: spec.id,
        commit,
        skills: result.installedSkillIds.length,
        links: result.links.linksRewritten
      });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  private async installFromBundle(spec: BuiltinSkillSourceSpec, bundledCommit: string): Promise<void> {
    const snapshotDir = await this.extractBundledSnapshot(spec);
    try {
      const result = installBuiltinSnapshot({
        skillsDir: this.options.skillsDir,
        snapshotDir,
        spec,
        commit: bundledCommit
      });
      const sourceState = this.sourceState(spec.id);
      sourceState.installedCommit = bundledCommit;
      sourceState.installedAt = new Date().toISOString();
      sourceState.installedSkillIds = result.installedSkillIds;
      sourceState.bundledCommitSeen = bundledCommit;
      sourceState.lastError = null;
      this.options.logger.info('Built-in skills installed from the bundled snapshot.', {
        source: spec.id,
        commit: bundledCommit,
        skills: result.installedSkillIds.length
      });
    } finally {
      rmSync(snapshotDir, { recursive: true, force: true });
    }
  }

  /**
   * Extracts `resources/builtin-skills/<id>.tar.gz` into a temporary directory.
   *
   * The snapshot ships as an archive rather than a source tree so the upstream repositories' own
   * Python/JS tooling never enters Roc's workspace scans; the sha256 in `catalog.json` is checked
   * before extraction because an installed app's resources are still input.
   */
  private async extractBundledSnapshot(spec: BuiltinSkillSourceSpec): Promise<string> {
    if (spec.snapshot === null) {
      throw new Error(`builtin_skills_snapshot_missing:${spec.id}`);
    }
    const archivePath = join(this.options.bundledRoot, spec.snapshot.fileName);
    if (!existsSync(archivePath)) {
      throw new Error(`builtin_skills_snapshot_missing:${spec.id}`);
    }
    const archive = readFileSync(archivePath);
    const digest = createHash('sha256').update(archive).digest('hex');
    if (digest !== spec.snapshot.sha256) {
      throw new Error(`builtin_skills_snapshot_checksum:${spec.id}`);
    }
    const snapshotDir = join(
      this.options.skillsDir,
      `.builtin-bundle-${spec.id}-${process.pid}-${Date.now()}`
    );
    rmSync(snapshotDir, { recursive: true, force: true });
    try {
      await extractTarGz(archive, snapshotDir);
    } catch (error) {
      rmSync(snapshotDir, { recursive: true, force: true });
      throw error;
    }
    return snapshotDir;
  }

  private recordError(spec: BuiltinSkillSourceSpec, message: string): void {
    this.sourceState(spec.id).lastError = message;
    this.options.logger.warn('Built-in skills unavailable.', { source: spec.id, error: message });
  }

  private sourceStatus(spec: BuiltinSkillSourceSpec): BuiltinSkillSourceStatus {
    const sourceState = this.sourceState(spec.id);
    return {
      id: spec.id,
      displayName: spec.displayName,
      repo: spec.repo,
      ref: spec.ref,
      license: spec.license,
      homepage: spec.homepage,
      bundledCommit: this.bundledCommit(spec) ?? '',
      installedCommit: sourceState.installedCommit,
      skillIds: readManagedSkillIds(this.options.skillsDir, spec.id),
      lastCheckedAt: sourceState.lastCheckedAt,
      lastError: sourceState.lastError
    };
  }

  private bundledCommit(spec: BuiltinSkillSourceSpec): string | null {
    return spec.commit.length === 0 ? null : spec.commit;
  }

  private sourceState(sourceId: string): SourceState {
    const existing = this.state.sources[sourceId];
    if (existing !== undefined) {
      return existing;
    }
    const created: SourceState = {
      installedCommit: null,
      installedAt: null,
      installedSkillIds: [],
      lastCheckedAt: null,
      etag: null,
      lastError: null,
      bundledCommitSeen: null,
      licenseAcceptedAt: null
    };
    this.state.sources[sourceId] = created;
    return created;
  }

  private persist(): void {
    const path = this.options.statePath;
    mkdirSync(join(path, '..'), { recursive: true });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    renameSync(temporary, path);
  }

  private isCheckDue(): boolean {
    if (this.state.lastCheckedAt === null) {
      return true;
    }
    const last = Date.parse(this.state.lastCheckedAt);
    if (Number.isNaN(last)) {
      return true;
    }
    return Date.now() - last >= (this.options.intervalMs ?? defaultCheckIntervalMs);
  }

  private scheduleDailyCheck(): void {
    this.clearTimer();
    const interval = this.options.intervalMs ?? defaultCheckIntervalMs;
    this.timer = setInterval(() => {
      if (!this.state.autoUpdate) {
        return;
      }
      void this.runCheck({ force: false }).catch((error: unknown) => {
        this.options.logger.warn('Built-in skills scheduled check failed.', toLogMetadata(error));
      });
    }, interval);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.initialTimer !== null) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
  }

  private emitUpdated(): void {
    const status = this.status();
    this.options.onUpdated?.(status);
  }

  private fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? globalThis.fetch;
  }
}

function readBundledSpecs(bundledRoot: string): readonly BuiltinSkillSourceSpec[] | null {
  try {
    const catalog = readBuiltinSkillsCatalog(bundledRoot);
    return catalog.sources.length === 0 ? null : catalog.sources;
  } catch {
    return null;
  }
}

function loadState(path: string): BuiltinSkillsState {
  const empty: BuiltinSkillsState = {
    schemaVersion: stateSchemaVersion,
    autoUpdate: true,
    lastCheckedAt: null,
    sources: {}
  };
  if (!existsSync(path)) {
    return empty;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return empty;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return empty;
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== stateSchemaVersion || typeof record.sources !== 'object' || record.sources === null) {
    return empty;
  }
  const sources: Record<string, SourceState> = {};
  for (const [sourceId, value] of Object.entries(record.sources as Record<string, unknown>)) {
    sources[sourceId] = parseSourceState(value);
  }
  return {
    schemaVersion: stateSchemaVersion,
    autoUpdate: record.autoUpdate !== false,
    lastCheckedAt: typeof record.lastCheckedAt === 'string' ? record.lastCheckedAt : null,
    sources
  };
}

function parseSourceState(value: unknown): SourceState {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  return {
    installedCommit: readString(record.installedCommit),
    installedAt: readString(record.installedAt),
    installedSkillIds: Array.isArray(record.installedSkillIds)
      ? record.installedSkillIds.filter((entry): entry is string => typeof entry === 'string')
      : [],
    lastCheckedAt: readString(record.lastCheckedAt),
    etag: readString(record.etag),
    lastError: readString(record.lastError),
    bundledCommitSeen: readString(record.bundledCommitSeen),
    licenseAcceptedAt: readString(record.licenseAcceptedAt)
  };
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toLogMetadata(error: unknown): Record<string, unknown> {
  return { error: errorMessage(error) };
}
