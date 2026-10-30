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
}>;

export type ToolAdmissionObserver = (observation: ToolAdmissionObservation) => void;

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

function sortedKinds(kinds: Iterable<ToolAdmissionResourceKind>): ToolAdmissionResourceKind[] {
  return [...new Set(kinds)].sort();
}

function addKinds(target: Set<ToolAdmissionResourceKind>, kinds: Iterable<ToolAdmissionResourceKind>): void {
  for (const kind of kinds) target.add(kind);
}

function hashIdentity(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function elapsedMs(start: number, end = performance.now()): number {
  return Math.max(0, Math.round(end - start));
}

function observe(observer: ToolAdmissionObserver | undefined, observation: ToolAdmissionObservation): void {
  try {
    observer?.(observation);
  } catch {
    // Diagnostics must not change admission or tool execution outcomes.
  }
}
