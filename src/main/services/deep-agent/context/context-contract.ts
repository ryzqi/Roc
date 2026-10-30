import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';

import {
  createEmptyContextContractAudit,
  type ContextContractAudit
} from '../../../../shared/schemas/run-diagnostics';
import { isValidContextArtifactLocator } from './context-artifact-store';

const acceptanceConditionSchema = z.object({
  id: z.string().min(1).max(80),
  description: z.string().max(2000)
}).strict();

const correctionSchema = z.object({
  id: z.string().min(1).max(128),
  content: z.string()
}).strict();

const contractSchema = z.object({
  userConstraints: z.array(z.string()).max(128),
  acceptanceIds: z.array(z.string().min(1).max(80)).max(20),
  acceptanceConditions: z.array(acceptanceConditionSchema).max(20).default([]),
  pendingEffects: z.array(z.string().min(1).max(128)).max(128),
  pendingApprovals: z.array(z.string().min(1).max(128)).max(128),
  pendingCorrections: z.array(correctionSchema).max(32).default([]),
  sourceSpans: z.array(z.string().max(2048)).max(32),
  workspaceVersions: z.array(z.string().min(1).max(128)).max(8).default([])
}).strict();

type ContextContract = z.infer<typeof contractSchema>;
type AcceptanceCondition = z.infer<typeof acceptanceConditionSchema>;
type Correction = z.infer<typeof correctionSchema>;

export type ContextControlState = Pick<ContextContract,
  | 'acceptanceIds'
  | 'acceptanceConditions'
  | 'pendingEffects'
  | 'pendingApprovals'
  | 'pendingCorrections'
>;

const contractId = 'roc-context-contract';
const MAX_USER_CONSTRAINTS = 128;
const MAX_ACCEPTANCE_CONDITIONS = 20;
const MAX_PENDING_ITEMS = 128;
const MAX_PENDING_CORRECTIONS = 32;
const MAX_SOURCE_SPANS = 32;
const MAX_WORKSPACE_VERSIONS = 8;

export function isContextContract(message: BaseMessage): boolean {
  return message.getType() === 'human' && message.id === contractId && message.additional_kwargs.roc_context_contract === true;
}

export function collectUserConstraints(messages: readonly BaseMessage[]): string[] {
  const constraints: string[] = [];
  for (const message of messages) {
    if (isContextContract(message)) {
      constraints.push(...(readContextContract(message)?.userConstraints ?? []));
    } else if (message.getType() === 'human') {
      constraints.push(typeof message.content === 'string' ? message.content : JSON.stringify(message.content));
    }
  }
  return [...new Set(constraints)];
}

export function collectContextRequirements(
  messages: readonly BaseMessage[],
  state: ContextControlState
): string[] {
  const requirements = collectUserConstraints(messages);
  for (const message of messages) {
    if (!isContextContract(message)) continue;
    const contract = readContextContract(message);
    if (contract === null) continue;
    requirements.push(...contract.acceptanceConditions.map(condition => condition.description));
    requirements.push(...contract.pendingCorrections.map(correction => correction.content));
  }
  requirements.push(...state.acceptanceConditions.map(condition => condition.description));
  requirements.push(...state.pendingCorrections.map(correction => correction.content));
  return [...new Set(requirements)];
}

// Runtime facts survive independently of the model's lossy summary and cannot be marked satisfied by it.
export function pinContextContract(
  messages: readonly BaseMessage[],
  original: readonly BaseMessage[],
  state: ContextControlState,
  sourceSpans: readonly string[],
  workspaceHash: string | null
): BaseMessage[] {
  return pinContextContractWithAudit(messages, original, state, sourceSpans, workspaceHash).messages;
}

export function pinContextContractWithAudit(
  messages: readonly BaseMessage[],
  original: readonly BaseMessage[],
  state: ContextControlState,
  sourceSpans: readonly string[],
  workspaceHash: string | null
): { messages: BaseMessage[]; audit: ContextContractAudit } {
  const contractMessages = original.filter(isContextContract);
  const previous = contractMessages.flatMap(message => {
    const contract = readContextContract(message);
    return contract === null ? [] : [contract];
  });
  const invalidContractCount = contractMessages.length - previous.length;
  const retained = new Set(messages.filter(message => message.getType() === 'human' && !isContextContract(message))
    .map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)));
  const allConstraints = collectUserConstraints(original);
  const expectedConstraints = allConstraints.filter(text => !retained.has(text));
  const userConstraints = expectedConstraints.slice(-MAX_USER_CONSTRAINTS);
  const expectedAcceptanceConditions = mergeAcceptanceConditions(
    previous.flatMap(contract => contract.acceptanceConditions),
    state.acceptanceConditions
  );
  const acceptanceConditions = expectedAcceptanceConditions.slice(-MAX_ACCEPTANCE_CONDITIONS);
  const acceptanceIds = unique([
    ...previous.flatMap(contract => contract.acceptanceIds),
    ...state.acceptanceIds,
    ...state.acceptanceConditions.map(condition => condition.id)
  ]).slice(-MAX_ACCEPTANCE_CONDITIONS);
  const pendingEffects = unique(state.pendingEffects).slice(-MAX_PENDING_ITEMS);
  const pendingApprovals = unique(state.pendingApprovals).slice(-MAX_PENDING_ITEMS);
  const expectedCorrections = mergeCorrections(
    previous.flatMap(contract => contract.pendingCorrections),
    state.pendingCorrections
  );
  const pendingCorrections = expectedCorrections.slice(-MAX_PENDING_CORRECTIONS);
  const allSourceSpans = unique([
    ...previous.flatMap(contract => contract.sourceSpans),
    ...sourceSpans
  ]);
  const expectedSourceSpans = allSourceSpans.filter(isValidContextArtifactLocator);
  const validSourceSpans = expectedSourceSpans.slice(-MAX_SOURCE_SPANS);
  const workspaceVersions = unique([
    ...previous.flatMap(contract => contract.workspaceVersions),
    ...(workspaceHash === null ? [] : [workspaceHash])
  ]).slice(-MAX_WORKSPACE_VERSIONS);
  const contract = contractSchema.parse({
    userConstraints,
    acceptanceIds,
    acceptanceConditions,
    pendingEffects,
    pendingApprovals,
    pendingCorrections,
    sourceSpans: validSourceSpans,
    workspaceVersions
  });
  const invalidEvidenceLocatorCount = allSourceSpans.length - allSourceSpans.filter(isValidContextArtifactLocator).length;
  const audit = createEmptyContextContractAudit();
  audit.constraintCount = allConstraints.length;
  audit.missingConstraintCount = Math.max(0, expectedConstraints.length - userConstraints.length);
  audit.acceptanceConditionCount = expectedAcceptanceConditions.length;
  audit.missingAcceptanceConditionCount = expectedAcceptanceConditions.filter(condition =>
    !acceptanceConditions.some(retainedCondition => retainedCondition.id === condition.id &&
      retainedCondition.description === condition.description)).length;
  audit.pendingEffectCount = state.pendingEffects.length;
  audit.missingPendingEffectCount = state.pendingEffects.filter(id => !pendingEffects.includes(id)).length;
  audit.pendingApprovalCount = state.pendingApprovals.length;
  audit.missingPendingApprovalCount = state.pendingApprovals.filter(id => !pendingApprovals.includes(id)).length;
  audit.pendingCorrectionCount = expectedCorrections.length;
  audit.missingPendingCorrectionCount = expectedCorrections.filter(correction =>
    !pendingCorrections.some(retainedCorrection => retainedCorrection.id === correction.id &&
      retainedCorrection.content === correction.content)).length;
  audit.evidenceLocatorCount = validSourceSpans.length;
  audit.missingEvidenceLocatorCount = expectedSourceSpans.length - validSourceSpans.length;
  audit.invalidContractCount = invalidContractCount;
  audit.invalidEvidenceLocatorCount = invalidEvidenceLocatorCount;
  audit.workspaceVersionPresent = workspaceVersions.length > 0;

  if (Object.values(contract).every(items => items.length === 0)) {
    return { messages: messages.filter(message => !isContextContract(message)), audit };
  }
  const pinned = new HumanMessage({ id: contractId, content: JSON.stringify(contract),
    additional_kwargs: { roc_context_contract: true } });
  const result = messages.filter(message => !isContextContract(message));
  const firstHuman = result.findIndex(message => message.getType() === 'human');
  result.splice(firstHuman < 0 ? 0 : firstHuman + 1, 0, pinned);
  return { messages: result, audit };
}

function mergeAcceptanceConditions(
  previous: ReadonlyArray<AcceptanceCondition>,
  current: ReadonlyArray<AcceptanceCondition>
): AcceptanceCondition[] {
  const byId = new Map<string, z.infer<typeof acceptanceConditionSchema>>();
  for (const condition of [...previous, ...current]) {
    byId.set(condition.id, condition);
  }
  return [...byId.values()];
}

function mergeCorrections(
  previous: ReadonlyArray<Correction>,
  current: ReadonlyArray<Correction>
): Correction[] {
  const byId = new Map<string, z.infer<typeof correctionSchema>>();
  for (const correction of [...previous, ...current]) {
    const existing = byId.get(correction.id);
    if (existing !== undefined && existing.content !== correction.content) {
      throw new Error('context_contract_correction_content_changed');
    }
    byId.set(correction.id, correction);
  }
  return [...byId.values()];
}

function readContextContract(message: BaseMessage): ContextContract | null {
  try {
    return contractSchema.parse(JSON.parse(String(message.content)));
  } catch {
    return null;
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
