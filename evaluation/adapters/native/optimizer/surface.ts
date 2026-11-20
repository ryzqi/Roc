import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * P5-01: the only part of the harness an offline optimizer may rewrite.
 *
 * A surface is a closed set of declarative text components. There is deliberately no field for
 * permissions, budget, scoring, tools, environment or middleware: those live in the frozen
 * revision and a proposal that tries to name them is rejected before anything is materialised.
 */
export const surfaceComponentKinds = ['prompt', 'guidance', 'skill', 'context'] as const;
export type SurfaceComponentKind = (typeof surfaceComponentKinds)[number];

export type SurfaceComponent = { id: string; kind: SurfaceComponentKind; value: string };
export type HarnessSurface = { schemaVersion: 1; revision: string; components: SurfaceComponent[] };

const componentSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9.-]{0,63}$/u),
  kind: z.enum(surfaceComponentKinds),
  value: z.string().max(4000)
}).strict();

const surfaceSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.string().min(1).max(80),
  components: z.array(componentSchema).min(1).max(64)
}).strict();

export const proposalSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
  rationale: z.string().min(1).max(2000),
  edits: z.array(z.object({
    path: z.string().min(1).max(120),
    value: z.string().max(4000)
  }).strict()).min(1).max(12)
}).strict();

export type SurfaceProposal = z.infer<typeof proposalSchema>;

/** Stable serialisation: keys sorted, no whitespace, so a hash identifies content only. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}

export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

const editablePath = /^components\.(prompt|guidance|skill|context)\.([a-z0-9][a-z0-9-]{0,39})$/u;
// Paths are the authoritative routing table; a name that hints at an execution, budget or scoring
// knob is never editable even if it happens to sit under a component namespace.
const forbiddenPathToken =
  /(permission|authoriz|budget|cost|deadline|scorer|score|verifier|verify|holdout|split|policy|tool|credential|secret|environment|middleware|feature|limit|approval|schema)/iu;
const unsafeValue = /(?:\.\.\/|\0|(?:^|\s)(?:\/|~\/|[A-Za-z]:\\))/u;
const holdoutReference = /\bholdout\b/iu;

export type MaterialisedSurface = { surface: HarnessSurface; hash: string; changedIds: string[]; proposalId: string };

function parseProposal(proposal: unknown): SurfaceProposal {
  const parsed = proposalSchema.safeParse(proposal);
  if (!parsed.success) throw new Error(`optimizer_proposal_rejected:invalid_shape:${parsed.error.issues[0]?.path.join('.') ?? 'root'}`);
  return parsed.data;
}

/**
 * Rejects anything outside the declarative surface. The error text is part of the contract: the
 * optimizer retries an invalid proposal at most once and then falls back to the base surface.
 */
export function validateProposal(base: HarnessSurface, proposal: unknown): SurfaceProposal {
  surfaceSchema.parse(base);
  const parsed = parseProposal(proposal);
  const known = new Map(base.components.map(component => [component.id, component]));
  const edited = new Set<string>();
  for (const edit of parsed.edits) {
    // Forbidden names win over shape: naming a permission/budget/scorer knob is an explicit
    // attempt to leave the declarative surface, not merely a misspelled component.
    if (edit.path.split('.').some(segment => forbiddenPathToken.test(segment))) {
      throw new Error(`optimizer_proposal_rejected:forbidden_surface:${edit.path}`);
    }
    const match = editablePath.exec(edit.path);
    if (match === null) throw new Error(`optimizer_proposal_rejected:not_editable:${edit.path}`);
    const id = `${match[1]}.${match[2]}`;
    if (!known.has(id)) throw new Error(`optimizer_proposal_rejected:unknown_component:${id}`);
    if (edited.has(id)) throw new Error(`optimizer_proposal_rejected:duplicate_edit:${id}`);
    edited.add(id);
    if (unsafeValue.test(edit.value)) throw new Error(`optimizer_proposal_rejected:unsafe_value:${id}`);
    if (holdoutReference.test(edit.value)) throw new Error(`optimizer_holdout_protected:${id}`);
  }
  return parsed;
}

/** Compose: base + edits, deterministic revision derived from content only. */
export function materialiseSurface(base: HarnessSurface, proposal: unknown): MaterialisedSurface {
  const parsed = validateProposal(base, proposal);
  const values = new Map(base.components.map(component => [component.id, component.value]));
  const changedIds: string[] = [];
  for (const edit of parsed.edits) {
    const match = editablePath.exec(edit.path);
    if (match === null) throw new Error(`optimizer_proposal_rejected:not_editable:${edit.path}`);
    const id = `${match[1]}.${match[2]}`;
    if (values.get(id) !== edit.value) changedIds.push(id);
    values.set(id, edit.value);
  }
  const components = base.components
    .map(component => ({ ...component, value: values.get(component.id) ?? component.value }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const hash = contentHash({ schemaVersion: 1, components });
  const surface: HarnessSurface = { schemaVersion: 1, revision: `rev-${hash.slice(0, 16)}`, components };
  return { surface, hash, changedIds, proposalId: parsed.id };
}

export function surfaceHash(surface: HarnessSurface): string {
  return contentHash({ schemaVersion: 1, components: surface.components });
}

export function componentValue(surface: HarnessSurface, id: string): string | undefined {
  return surface.components.find(component => component.id === id)?.value;
}

export type TrajectoryStep = {
  index: number;
  kind: 'model' | 'tool' | 'verifier';
  name: string;
  inputHash: string;
  outputHash: string;
  tokens: number;
  status: 'ok' | 'failed';
};

export type HarnessTrajectory = {
  schemaVersion: 1;
  experimentId: string;
  scenarioId: string;
  surfaceRevision: string;
  steps: TrajectoryStep[];
  final: { score: number | null; artifactRefs: string[] };
};

const hashPattern = /^[0-9a-f]{64}$/u;
const trajectorySchema = z.object({
  schemaVersion: z.literal(1),
  experimentId: z.string().min(1),
  scenarioId: z.string().min(1),
  surfaceRevision: z.string().min(1),
  steps: z.array(z.object({
    index: z.number().int().nonnegative(),
    kind: z.enum(['model', 'tool', 'verifier']),
    name: z.string().min(1),
    inputHash: z.string().regex(hashPattern),
    outputHash: z.string().regex(hashPattern),
    tokens: z.number().int().nonnegative(),
    status: z.enum(['ok', 'failed'])
  }).strict()),
  final: z.object({
    score: z.number().min(0).max(1).nullable(),
    artifactRefs: z.array(z.string())
  }).strict()
}).strict();

/** Trajectory format is validated and canonicalised; two equal trajectories serialise identically. */
export function normalizeTrajectory(input: unknown): HarnessTrajectory {
  const parsed = trajectorySchema.safeParse(input);
  if (!parsed.success) throw new Error(`optimizer_trajectory_invalid:${parsed.error.issues[0]?.message ?? 'shape'}`);
  parsed.data.steps.forEach((step, index) => {
    if (step.index !== index) throw new Error(`optimizer_trajectory_invalid:non_sequential_index:${step.index}`);
  });
  return parsed.data;
}

export function serializeTrajectory(input: unknown): string {
  return canonicalJson(normalizeTrajectory(input));
}
