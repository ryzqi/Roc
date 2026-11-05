import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { RunCapabilityManifestToolV1, RunExecutionSnapshot } from '../../../shared/types';

export const TOOL_ADMISSION_RESOURCE_KINDS = [
  'app_run',
  'background_tasks',
  'global_config',
  'global_fallback',
  'memory',
  'network',
  'research',
  'workspace'
] as const;

export type ToolAdmissionResourceKind = (typeof TOOL_ADMISSION_RESOURCE_KINDS)[number];
type ResourceAccess = 'read' | 'write';

export type ToolAdmissionResourceClaim = Readonly<{
  kind: ToolAdmissionResourceKind;
  key: string;
  access: ResourceAccess;
  /** Only workspace claims carry a canonical path; observers never receive it. */
  path?: string;
}>;

export type ToolAdmissionObservation = Readonly<{
  status: 'released' | 'cancelled';
  waitMs: number;
  holdMs: number | null;
  resourceKinds: readonly ToolAdmissionResourceKind[];
  conflictKinds: readonly ToolAdmissionResourceKind[];
  /** Private correlation only; telemetry replaces caller identifiers with local span aliases. */
  toolCallId?: string;
  endOffsetMs?: number;
}>;

export type ToolAdmissionObserver = (observation: ToolAdmissionObservation) => void;

export type ResearchProcessAdmissionRequest = Readonly<{
  projectId: string | null;
  priority: 'user' | 'background';
  resourceClass: 'parse' | 'compute' | 'utility';
  gpu: boolean;
}>;

type ResearchProcessAdmissionResourceKind = 'research' | 'research_cpu' | 'research_gpu' | 'research_parse';
type ResearchProcessAdmissionObservation = Readonly<{
  status: 'released' | 'cancelled';
  waitMs: number;
  holdMs: number | null;
  resourceKinds: readonly ResearchProcessAdmissionResourceKind[];
  conflictKinds: readonly ResearchProcessAdmissionResourceKind[];
}>;
type ResearchProcessAdmissionObserver = (observation: ResearchProcessAdmissionObservation) => void;

export type ResearchProcessAdmissionLease = Readonly<{
  waitMs: number;
  release: () => ResearchProcessAdmissionObservation & { status: 'released'; holdMs: number };
}>;

type ProcessWaiter = {
  request: ResearchProcessAdmissionRequest;
  enqueuedAt: number;
  yielded: boolean;
  conflictKinds: Set<ResearchProcessAdmissionResourceKind>;
  signal: AbortSignal | undefined;
  observer: ResearchProcessAdmissionObserver | undefined;
  abort: () => void;
  resolve: (lease: ResearchProcessAdmissionLease) => void;
  reject: (error: Error) => void;
};

export type ToolAdmissionResourceRequest = Readonly<{
  claims: readonly ToolAdmissionResourceClaim[];
  verifyWorkspaceIdentity: () => Promise<void>;
}>;

export type ResolveToolAdmissionResourcesInput = Readonly<{
  policy: Pick<RunCapabilityManifestToolV1, 'canonicalIdentity' | 'effectClass' | 'modelVisibleName' | 'resourceScope'>;
  runId: string;
  workspaceHash: string | null;
  workspacePath: string | null;
  workspaceIdentity: RunExecutionSnapshot['workspaceIdentity'];
  researchProjectId: string | null | undefined;
}>;

type WaitingRequest = {
  claims: readonly ToolAdmissionResourceClaim[];
  enqueuedAt: number;
  signal: AbortSignal | undefined;
  observer: ToolAdmissionObserver | undefined;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  abort: () => void;
  conflictKinds: Set<ToolAdmissionResourceKind>;
};

type ActiveRequest = {
  claims: readonly ToolAdmissionResourceClaim[];
  enqueuedAt: number;
  acquiredAt: number;
  observer: ToolAdmissionObserver | undefined;
  conflictKinds: Set<ToolAdmissionResourceKind>;
};

const GLOBAL_FALLBACK: ToolAdmissionResourceClaim = {
  kind: 'global_fallback',
  key: 'all',
  access: 'write'
};

const RUN_LOCAL_APP_TOOLS = new Set(['ask_user', 'resolve_background_task_time', 'write_todos']);
const BACKGROUND_TASK_TOOLS = new Set([
  'cancel_background_task',
  'propose_background_task',
  'read_background_task',
  'schedule_background_task',
  'update_background_task'
]);

/**
 * A process-local, fair resource-set scheduler. It grants a complete set in one step,
 * so acquiring claims in different orders cannot deadlock. Electron's single-instance
 * lock keeps agent runs in this main process; unrelated processes are outside this gate.
 */
export class ToolResourceCoordinator {
  private readonly active = new Set<ActiveRequest>();
  private readonly waiting: WaitingRequest[] = [];
  private readonly processActive = new Set<ProcessWaiter>();
  private readonly processWaiting: ProcessWaiter[] = [];
  private processCleanupUnresolved = false;

  get researchProcesses(): Readonly<{ active: number; queued: number; cleanupUnresolved: boolean }> {
    return { active: this.processActive.size, queued: this.processWaiting.length, cleanupUnresolved: this.processCleanupUnresolved };
  }

  acquireResearchProcess(request: ResearchProcessAdmissionRequest, signal?: AbortSignal, observer?: ResearchProcessAdmissionObserver): Promise<ResearchProcessAdmissionLease> {
    if ((request.projectId !== null && (typeof request.projectId !== 'string' || request.projectId.trim().length === 0)) ||
        !['user', 'background'].includes(request.priority) || !['parse', 'compute', 'utility'].includes(request.resourceClass) || typeof request.gpu !== 'boolean') {
      return Promise.reject(new Error('research_process_admission_invalid'));
    }
    if (this.processCleanupUnresolved) return Promise.reject(new Error('research_process_cleanup_unresolved'));
    if (signal?.aborted === true) return Promise.reject(new Error('research_process_cancelled'));
    if (this.processWaiting.length >= 256) return Promise.reject(new Error('research_process_admission_queue_limit'));
    return new Promise((resolvePromise, rejectPromise) => {
      const waiter: ProcessWaiter = {
        request: { ...request }, enqueuedAt: performance.now(), yielded: false, conflictKinds: new Set(), signal, observer,
        resolve: resolvePromise, reject: rejectPromise,
        abort: () => {
          const index = this.processWaiting.indexOf(waiter);
          if (index < 0) return;
          this.processWaiting.splice(index, 1);
          signal?.removeEventListener('abort', waiter.abort);
          observe(observer, { status: 'cancelled', waitMs: elapsedMs(waiter.enqueuedAt), holdMs: null,
            resourceKinds: processResourceKinds(waiter.request), conflictKinds: sortedKinds(waiter.conflictKinds) });
          rejectPromise(new Error('research_process_cancelled'));
          this.drainResearchProcesses();
        }
      };
      signal?.addEventListener('abort', waiter.abort, { once: true });
      this.processWaiting.push(waiter);
      this.drainResearchProcesses();
    });
  }

  /** An uncleaned process must not be followed by more computation in this host. */
  quarantineResearchProcesses(): void {
    this.processCleanupUnresolved = true;
    for (const waiter of this.processWaiting.splice(0)) {
      waiter.signal?.removeEventListener('abort', waiter.abort);
      observe(waiter.observer, { status: 'cancelled', waitMs: elapsedMs(waiter.enqueuedAt), holdMs: null,
        resourceKinds: processResourceKinds(waiter.request), conflictKinds: sortedKinds(waiter.conflictKinds) });
      waiter.reject(new Error('research_process_cleanup_unresolved'));
    }
  }

  private processConflicts(request: ResearchProcessAdmissionRequest): Set<ResearchProcessAdmissionResourceKind> {
    const conflicts = new Set<ResearchProcessAdmissionResourceKind>();
    if (this.processActive.size >= 2) conflicts.add('research_cpu');
    for (const active of this.processActive) {
      if (active.request.projectId === request.projectId) conflicts.add('research');
      if (request.resourceClass === 'parse' && active.request.resourceClass === 'parse') conflicts.add('research_parse');
      if (request.gpu && active.request.gpu) conflicts.add('research_gpu');
    }
    return conflicts;
  }

  private drainResearchProcesses(): void {
    if (this.processCleanupUnresolved) return;
    while (true) {
      const eligible = this.processWaiting.filter(waiter => {
        const conflicts = this.processConflicts(waiter.request);
        addKinds(waiter.conflictKinds, conflicts);
        return conflicts.size === 0;
      });
      const first = eligible[0];
      if (first === undefined) return;
      const foreground = first.request.priority === 'background' && !first.yielded
        ? eligible.find(waiter => waiter.request.priority === 'user')
        : undefined;
      if (foreground !== undefined) first.yielded = true;
      const waiter = foreground ?? first;
      this.processWaiting.splice(this.processWaiting.indexOf(waiter), 1);
      waiter.signal?.removeEventListener('abort', waiter.abort);
      const acquiredAt = performance.now();
      this.processActive.add(waiter);
      let released: (ResearchProcessAdmissionObservation & { status: 'released'; holdMs: number }) | null = null;
      waiter.resolve({
        waitMs: elapsedMs(waiter.enqueuedAt, acquiredAt),
        release: () => {
          if (released !== null) return released;
          this.processActive.delete(waiter);
          released = { status: 'released', waitMs: elapsedMs(waiter.enqueuedAt, acquiredAt), holdMs: elapsedMs(acquiredAt),
            resourceKinds: processResourceKinds(waiter.request), conflictKinds: sortedKinds(waiter.conflictKinds) };
          observe(waiter.observer, released);
          this.drainResearchProcesses();
          return released;
        }
      });
    }
  }

  acquire(
    claims: readonly ToolAdmissionResourceClaim[],
    signal?: AbortSignal,
    observer?: ToolAdmissionObserver
  ): Promise<() => void> {
    const normalizedClaims = normalizeClaims(claims);
    const enqueuedAt = performance.now();
    const resourceKinds = kindsForClaims(normalizedClaims);

    if (signal?.aborted === true) {
      observe(observer, {
        status: 'cancelled',
        waitMs: 0,
        holdMs: null,
        resourceKinds,
        conflictKinds: []
      });
      return Promise.reject(signal.reason ?? new Error('tool_admission_aborted'));
    }

    return new Promise((resolvePromise, rejectPromise) => {
      let waiter: WaitingRequest;
      const abort = (): void => {
        const index = this.waiting.indexOf(waiter);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        signal?.removeEventListener('abort', abort);
        observe(observer, {
          status: 'cancelled',
          waitMs: elapsedMs(enqueuedAt),
          holdMs: null,
          resourceKinds,
          conflictKinds: sortedKinds(waiter.conflictKinds)
        });
        rejectPromise(signal?.reason ?? new Error('tool_admission_aborted'));
        this.drain();
      };
      waiter = {
        claims: normalizedClaims,
        enqueuedAt,
        signal,
        observer,
        resolve: resolvePromise,
        reject: rejectPromise,
        abort,
        conflictKinds: new Set()
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.waiting.push(waiter);
      if (signal?.aborted === true) abort();
      else this.drain();
    });
  }

  private drain(): void {
    const earlierBlocked: WaitingRequest[] = [];
    for (let index = 0; index < this.waiting.length;) {
      const waiter = this.waiting[index];
      if (waiter === undefined) break;
      const conflicts = new Set<ToolAdmissionResourceKind>();
      for (const active of this.active) {
        addKinds(conflicts, conflictingKinds(waiter.claims, active.claims));
      }
      for (const earlier of earlierBlocked) {
        addKinds(conflicts, conflictingKinds(waiter.claims, earlier.claims));
      }
      if (conflicts.size > 0) {
        addKinds(waiter.conflictKinds, conflicts);
        earlierBlocked.push(waiter);
        index += 1;
        continue;
      }

      this.waiting.splice(index, 1);
      waiter.signal?.removeEventListener('abort', waiter.abort);
      const active: ActiveRequest = {
        claims: waiter.claims,
        enqueuedAt: waiter.enqueuedAt,
        acquiredAt: performance.now(),
        observer: waiter.observer,
        conflictKinds: waiter.conflictKinds
      };
      this.active.add(active);
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.active.delete(active);
        observe(active.observer, {
          status: 'released',
          waitMs: elapsedMs(active.enqueuedAt, active.acquiredAt),
          holdMs: elapsedMs(active.acquiredAt),
          resourceKinds: kindsForClaims(active.claims),
          conflictKinds: sortedKinds(active.conflictKinds)
        });
        this.drain();
      });
    }
  }
}

function processResourceKinds(request: ResearchProcessAdmissionRequest): ResearchProcessAdmissionResourceKind[] {
  return ['research', 'research_cpu', ...(request.resourceClass === 'parse' ? ['research_parse' as const] : []),
    ...(request.gpu ? ['research_gpu' as const] : [])];
}

export async function resolveToolAdmissionResources(
  input: ResolveToolAdmissionResourcesInput
): Promise<ToolAdmissionResourceRequest> {
  const access: ResourceAccess = input.policy.effectClass === 'none' || input.policy.effectClass === 'network_read'
    ? 'read'
    : 'write';
  const claims: ToolAdmissionResourceClaim[] = [];
  let verifyWorkspaceIdentity: () => Promise<void> = async () => {};
  const isResearchTool = input.policy.canonicalIdentity.startsWith('research:');

  if (isResearchTool) {
    if (input.researchProjectId === null || input.researchProjectId === undefined || input.researchProjectId.length === 0) {
      return fallbackRequest();
    }
    claims.push({ kind: 'research', key: hashIdentity(input.researchProjectId), access });
    const workspaceClaim = await resolveWorkspaceClaim(input, access);
    if (workspaceClaim === null) return fallbackRequest();
    claims.push(workspaceClaim.claim);
    verifyWorkspaceIdentity = workspaceClaim.verify;
  }

  switch (input.policy.resourceScope) {
    case 'workspace': {
      if (claims.some(claim => claim.kind === 'workspace')) break;
      const workspaceClaim = await resolveWorkspaceClaim(input, access);
      if (workspaceClaim === null) return fallbackRequest();
      claims.push(workspaceClaim.claim);
      verifyWorkspaceIdentity = workspaceClaim.verify;
      break;
    }
    case 'memory':
      claims.push({ kind: 'memory', key: 'global', access });
      if (input.workspaceHash !== null) {
        claims.push({ kind: 'memory', key: `workspace:${input.workspaceHash}`, access });
      }
      break;
    case 'network':
      claims.push({ kind: 'network', key: 'shared', access });
      break;
    case 'app':
      if (isResearchTool) break;
      if (input.policy.modelVisibleName === 'roc_self_config') {
        claims.push({ kind: 'global_config', key: 'roc', access });
      } else if (BACKGROUND_TASK_TOOLS.has(input.policy.modelVisibleName)) {
        claims.push({ kind: 'background_tasks', key: 'scheduler', access });
      } else if (RUN_LOCAL_APP_TOOLS.has(input.policy.modelVisibleName)) {
        claims.push({ kind: 'app_run', key: hashIdentity(input.runId), access });
      } else {
        return fallbackRequest();
      }
      break;
    case 'external':
      return fallbackRequest();
    default:
      return fallbackRequest();
  }

  return { claims: normalizeClaims(claims), verifyWorkspaceIdentity };
}

async function resolveWorkspaceClaim(
  input: ResolveToolAdmissionResourcesInput,
  access: ResourceAccess
): Promise<{ claim: ToolAdmissionResourceClaim; verify: () => Promise<void> } | null> {
  const expected = input.workspaceIdentity;
  const workspacePath = input.workspacePath;
  if (workspacePath === null || expected === null) return null;
  const verify = async (): Promise<void> => {
    let actualPath: string;
    let actualStat: Awaited<ReturnType<typeof stat>>;
    try {
      actualPath = await realpath(workspacePath);
      actualStat = await stat(actualPath);
    } catch {
      throw new Error('tool_admission_workspace_identity_unavailable');
    }
    if (
      !actualStat.isDirectory() ||
      actualPath !== expected.path ||
      String(actualStat.dev) !== expected.dev ||
      String(actualStat.ino) !== expected.ino
    ) {
      throw new Error('tool_admission_workspace_identity_changed');
    }
  };
  await verify();
  return {
    claim: {
      kind: 'workspace',
      key: `${expected.dev}:${expected.ino}`,
      path: expected.path,
      access
    },
    verify
  };
}

function fallbackRequest(): ToolAdmissionResourceRequest {
  return {
    claims: [GLOBAL_FALLBACK],
    verifyWorkspaceIdentity: async () => {}
  };
}

function normalizeClaims(claims: readonly ToolAdmissionResourceClaim[]): readonly ToolAdmissionResourceClaim[] {
  if (claims.length === 0 || claims.some(claim => claim.kind === 'global_fallback')) return [GLOBAL_FALLBACK];
  const deduplicated = new Map<string, ToolAdmissionResourceClaim>();
  for (const claim of claims) {
    const key = `${claim.kind}\u0000${claim.key}\u0000${claim.path ?? ''}`;
    const previous = deduplicated.get(key);
    if (previous === undefined || claim.access === 'write') deduplicated.set(key, claim);
  }
  return [...deduplicated.values()];
}

function conflictingKinds(
  left: readonly ToolAdmissionResourceClaim[],
  right: readonly ToolAdmissionResourceClaim[]
): Set<ToolAdmissionResourceKind> {
  const conflicts = new Set<ToolAdmissionResourceKind>();
  const leftFallback = left.some(claim => claim.kind === 'global_fallback');
  const rightFallback = right.some(claim => claim.kind === 'global_fallback');
  if (leftFallback || rightFallback) {
    addKinds(conflicts, kindsForClaims(left));
    addKinds(conflicts, kindsForClaims(right));
    conflicts.add('global_fallback');
    return conflicts;
  }

  for (const leftClaim of left) {
    for (const rightClaim of right) {
      const sameIdentity = leftClaim.kind === rightClaim.kind && leftClaim.key === rightClaim.key;
      const overlappingWorkspace = leftClaim.kind === 'workspace' && rightClaim.kind === 'workspace' &&
        leftClaim.path !== undefined && rightClaim.path !== undefined && pathsOverlap(leftClaim.path, rightClaim.path);
      if (!(sameIdentity || overlappingWorkspace)) continue;
      if (leftClaim.access === 'write' || rightClaim.access === 'write') {
        conflicts.add(leftClaim.kind);
        conflicts.add(rightClaim.kind);
      }
    }
  }
  return conflicts;
}

function pathsOverlap(leftPath: string, rightPath: string): boolean {
  const left = resolve(leftPath);
  const right = resolve(rightPath);
  return isSameOrAncestor(left, right) || isSameOrAncestor(right, left);
}

function isSameOrAncestor(parentPath: string, childPath: string): boolean {
  const pathFromParent = relative(parentPath, childPath);
  return pathFromParent === '' || (pathFromParent !== '..' && !pathFromParent.startsWith(`..${sep}`) && !isAbsolute(pathFromParent));
}

function kindsForClaims(claims: readonly ToolAdmissionResourceClaim[]): ToolAdmissionResourceKind[] {
  return sortedKinds(new Set(claims.map(claim => claim.kind)));
}

function sortedKinds<T extends string>(kinds: Iterable<T>): T[] {
  return [...new Set(kinds)].sort();
}

function addKinds<T extends string>(target: Set<T>, kinds: Iterable<T>): void {
  for (const kind of kinds) target.add(kind);
}

function hashIdentity(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function elapsedMs(start: number, end = performance.now()): number {
  return Math.max(0, Math.round(end - start));
}

function observe<T>(observer: ((observation: T) => void) | undefined, observation: T): void {
  try {
    observer?.(observation);
  } catch {
    // Diagnostics must not change admission or tool execution outcomes.
  }
}
