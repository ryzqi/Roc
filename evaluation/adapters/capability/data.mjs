import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { CACHE, directory, fail, hash, readJson, sha256, writeJson } from '../../lib/common.mjs';
import { loadDataset, sealDataset } from '../../lib/data.mjs';
import { loadPython } from '../../lib/local-python.mjs';
import { ragCorpusSchema } from '../rag/data.mjs';
import { retrievalConfigurationSchema } from '../rag/environment.mjs';
import { capabilityFixtureSourceHash } from './fixture.mjs';
import { capabilityRelativePath, importCapabilitySources, verifyCapabilitySources } from './sources.mjs';

const registry = readJson(new URL('../../datasets/registry.json', import.meta.url));
export const capabilitySuites = Object.freeze(['roc-capability', 'roc-e2e-research', 'roc-security']);
export const capabilityFamilyQuotas = Object.freeze({ ...registry.holdoutQuotas });
export const e2eFamilyQuotas = Object.freeze({ ...registry.e2eQuotas });
export const capabilityFamilies = Object.freeze(Object.keys(capabilityFamilyQuotas));
const metricNames = Object.freeze([
  'taskCompletion', 'milestoneCompletion', 'toolSelectionAccuracy', 'argumentAccuracy',
  'evidencePrecision', 'citationValidity', 'artifactCompleteness', 'executionCorrectness',
  'unauthorizedSideEffectRate', 'permissionBypassRate', 'sensitiveDataLeakRate',
  'approvalBypassRate', 'duplicateSideEffectRate', 'wrongSourceRate', 'staleEvidenceRate',
  'hiddenTruthLeakRate', 'artifactIntegrityErrorRate'
]);
export const capabilityMetrics = Object.freeze(Object.fromEntries(capabilitySuites.map(suite => [suite, metricNames])));
export const capabilityProductionTools = Object.freeze([
  'write_todos', 'ls', 'read_file', 'write_file', 'edit_file', 'glob', 'grep',
  'session_search', 'memory_search', 'remember', 'read_context_artifact',
  'research_search_knowledge', 'research_read_knowledge_context', 'run_shell_command', 'lookup_record'
]);
const complexTools = new Set(['session_search']);
const unsupportedFamilies = Object.freeze({
  'planning-subagent-orchestration': 'production_subagent_evidence_unavailable',
  'cancellation-crash-concurrency': 'production_lifecycle_fault_evidence_unavailable',
  'systematic-review': 'production_human_screening_and_systematic_review_evidence_unavailable',
  'writing-publication': 'production_pdf_compilation_and_publication_evidence_unavailable'
});
const kinds = new Set(['json-value', 'tool-call', 'file', 'execution', 'citation', 'memory', 'stateful', 'mcp', 'context']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
const requireData = (condition, code) => { if (!condition) fail('data', code); };
const identity = value => value.trim().normalize('NFKC').toLowerCase();
const evidenceFile = 'source-evidence.json';

function jsonValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    requireData(Number.isFinite(value), 'capability_json_nonfinite');
    return;
  }
  requireData(Array.isArray(value) || object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)),
    'capability_json_value_invalid');
  for (const [key, child] of Object.entries(value)) {
    requireData(!forbiddenKeys.has(key), 'capability_json_unsafe_key');
    jsonValue(child);
  }
}
function fields(value, allowed, code) {
  requireData(object(value) && Object.keys(value).every(key => allowed.includes(key)), code);
}
function unique(values, code) { requireData(new Set(values).size === values.length, code); }
function outputPath(path) {
  requireData(Array.isArray(path) && path.every(key => typeof key === 'string' && !forbiddenKeys.has(key)),
    'capability_json_check_path_invalid');
}
function artifact(check, { allowExistence = false } = {}) {
  const value = typeof check === 'string' ? { path: check } : check;
  requireData(object(value), 'capability_file_check_invalid');
  capabilityRelativePath(value.path);
  requireData(value.sha256 === undefined || digest(value.sha256), 'capability_file_hash_invalid');
  requireData(value.content === undefined || typeof value.content === 'string', 'capability_file_content_invalid');
  requireData(allowExistence || value.sha256 !== undefined || value.content !== undefined,
    'capability_file_ground_truth_missing');
  if (value.sha256 !== undefined && value.content !== undefined) {
    requireData(sha256(value.content) === value.sha256, 'capability_file_ground_truth_hash_mismatch');
  }
}
function workspacePath(value) {
  requireData(typeof value === 'string' && value.startsWith('/workspace/'), 'capability_tool_path_escape');
  capabilityRelativePath(value.slice('/workspace/'.length));
}
function hiddenJson(value) {
  if (Array.isArray(value)) return value.some(hiddenJson);
  if (!object(value)) return false;
  return Object.entries(value).some(([key, child]) =>
    /^(?:expected|expectedRef|ground[_-]?truth|answer[_-]?key|reference[_-]?answer|gold[_-]?(?:answer|label)|answers|reviewers|grader|annotations)$/iu.test(key)
    || hiddenJson(child));
}
function visibleBoundary(task) {
  fields(task.visible, ['prompt', 'files', 'outputContract'], 'capability_visible_invalid');
  requireData(text(task.visible.prompt) && object(task.visible.files)
    && (task.visible.outputContract === undefined || text(task.visible.outputContract)), 'capability_visible_invalid');
  const privateObjects = [task.expected, task.expected.answer].filter(value => object(value) || Array.isArray(value));
  const privateJson = privateObjects.flatMap(value => [JSON.stringify(value), JSON.stringify(value, null, 2)]);
  const publicStrings = [task.visible.prompt, task.visible.outputContract ?? '', ...Object.values(task.visible.files),
    ...(task.environment.research?.documents ?? []).map(document => document.content),
    ...(task.environment.session?.turns ?? []).flatMap(turn =>
      [turn.prompt, ...(turn.responseContract === undefined ? [] : [JSON.stringify(turn.responseContract)])])];
  requireData(publicStrings.every(value => typeof value === 'string'
    && !privateJson.some(fragment => fragment.length > 2 && value.includes(fragment))), 'capability_hidden_truth_leakage');
  for (const value of publicStrings) {
    let parsed;
    try { parsed = JSON.parse(value); } catch { continue; }
    requireData(!hiddenJson(parsed), 'capability_hidden_truth_leakage');
  }
  const paths = Object.keys(task.visible.files);
  unique(paths.map(identity), 'capability_visible_path_alias');
  for (const path of paths) {
    capabilityRelativePath(path);
    requireData(!/^(?:sources|source-evidence|dataset|tasks|mapping|expected|ground[_-]?truth|grader|annotations|reviews)(?:[/.]|$)/iu.test(path),
      'capability_hidden_truth_visible_path');
    requireData(typeof task.visible.files[path] === 'string', 'capability_visible_file_invalid');
    requireData(!paths.some(other => identity(other).startsWith(`${identity(path)}/`)), 'capability_visible_path_collision');
    let parsed;
    try { parsed = JSON.parse(task.visible.files[path]); } catch { continue; }
    requireData(!hiddenJson(parsed) && (!object(parsed) || hash(parsed) !== hash(task.expected)),
      'capability_hidden_truth_leakage');
    if (object(task.expected.answer) || Array.isArray(task.expected.answer)) {
      requireData(hash(parsed) !== hash(task.expected.answer), 'capability_hidden_truth_leakage');
    }
  }
}
/** The attestation binds all four task fields; a local seal is not a signature. */
export function capabilityReviewContentHash(task) {
  return hash({ visible: task.visible, expected: task.expected, environment: task.environment, source: task.source });
}
function reviewState(task) {
  fields(task.review, ['producer', 'reviewers', 'arbiter'], 'capability_review_invalid');
  requireData(text(task.review.producer) && Array.isArray(task.review.reviewers), 'capability_review_invalid');
  const contentHash = capabilityReviewContentHash(task);
  const producer = identity(task.review.producer), reviewers = [];
  const decision = value => {
    requireData(text(value), 'capability_review_decision_invalid');
    const normalized = identity(value);
    if (['accept', 'accepted', 'approve', 'approved'].includes(normalized)) return 'accept';
    requireData(['reject', 'rejected', 'revise', 'changes-requested'].includes(normalized),
      'capability_review_decision_invalid');
    return normalized === 'revise' || normalized === 'changes-requested' ? 'revise' : 'reject';
  };
  const annotation = value => {
    fields(value, ['reviewer', 'contentHash', 'decision'], 'capability_review_annotation_invalid');
    requireData(text(value.reviewer) && value.contentHash === contentHash, 'capability_review_hash_mismatch');
    requireData(identity(value.reviewer) !== producer, 'capability_review_producer_not_independent');
    return { reviewer: identity(value.reviewer), decision: decision(value.decision) };
  };
  for (const value of task.review.reviewers) reviewers.push(annotation(value));
  unique(reviewers.map(value => value.reviewer), 'capability_duplicate_reviewer');
  let arbiter;
  if (task.review.arbiter !== undefined && task.review.arbiter !== null) {
    arbiter = annotation(task.review.arbiter);
    requireData(!reviewers.some(value => value.reviewer === arbiter.reviewer), 'capability_arbiter_not_independent');
  }
  const disagreement = new Set(reviewers.map(value => value.decision)).size > 1;
  if (disagreement) requireData(reviewers.length >= 2 && arbiter, 'capability_review_disagreement_needs_arbiter');
  const accepted = reviewers.length >= 2 && (disagreement
    ? arbiter.decision === 'accept' : reviewers.every(value => value.decision === 'accept'));
  return { contentHash, status: accepted ? 'reviewed' : reviewers.length >= 2 ? 'rejected' : 'draft',
    reviewers: reviewers.length, disagreement, accepted };
}
function researchAssets(task) {
  const research = task.environment.research;
  if (research === undefined) return null;
  fields(research, ['documents', 'documentIds', 'configuration'], 'capability_research_assets_invalid');
  const documents = ragCorpusSchema.shape.documents.parse(research.documents);
  unique(documents.map(document => document.id), 'capability_duplicate_research_document');
  unique(documents.filter(document => document.current).map(document => `${document.sourceId}\0${document.projectId}`),
    'capability_multiple_current_research_versions');
  requireData(Array.isArray(research.documentIds) && research.documentIds.length > 0
    && research.documentIds.every(text), 'capability_research_document_ids_invalid');
  unique(research.documentIds, 'capability_duplicate_research_document_id');
  const selected = documents.filter(document => research.documentIds.includes(document.id));
  requireData(selected.length === research.documentIds.length, 'capability_research_source_missing');
  requireData(new Set(selected.map(document => document.projectId).filter(id => id !== null)).size <= 1,
    'capability_research_cross_project_permissions');
  for (const document of documents) {
    requireData(sha256(document.content) === document.contentSha256, 'capability_research_source_hash_mismatch');
    let previous = 0;
    for (const block of document.blocks) {
      requireData(block.startOffset >= previous && block.endOffset > block.startOffset
        && block.endOffset <= document.content.length && document.content.slice(block.startOffset, block.endOffset).trim(),
      'capability_research_source_locator_invalid');
      previous = block.endOffset;
    }
    requireData(!hiddenJson((() => { try { return JSON.parse(document.content); } catch { return null; } })()),
      'capability_hidden_truth_leakage');
  }
  const config = retrievalConfigurationSchema.parse(research.configuration ?? {});
  requireData(config.mode === 'bm25' && config.rerank === 'none', 'capability_research_offline_bm25_required');
  return selected;
}
function executionAssets(task) {
  const execution = task.environment.execution;
  if (execution === undefined) return false;
  fields(execution, ['entrypoint', 'pythonEnvironment', 'pythonIdentity'], 'capability_execution_assets_invalid');
  requireData(execution.entrypoint === 'solution.py', 'capability_execution_entrypoint_invalid');
  requireData(text(execution.pythonEnvironment) && isAbsolute(execution.pythonEnvironment) && digest(execution.pythonIdentity),
    'capability_execution_lock_required');
  const environment = loadPython(execution.pythonEnvironment);
  requireData(environment.lock.identity === execution.pythonIdentity, 'capability_python_identity_changed');
  return true;
}
// Matches the production response-contract JSON Schema subset. No defaults,
// coercion, references, executable extensions, or output repair are accepted.
function responseContract(value) {
  fields(value, ['format', 'schema'], 'capability_response_contract_invalid');
  requireData(value.format === 'json' && object(value.schema)
    && JSON.stringify(value.schema).length <= 65536, 'capability_response_contract_invalid');
  const pending = [{ value: value.schema, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const { value: schema, depth } = pending.pop();
    requireData(object(schema) && depth <= 12 && ++nodes <= 256, 'capability_response_schema_limit');
    const allowed = {
      string: ['type', 'enum', 'minLength', 'maxLength'],
      number: ['type', 'enum', 'minimum', 'maximum'], integer: ['type', 'enum', 'minimum', 'maximum'],
      boolean: ['type', 'enum'], null: ['type'],
      array: ['type', 'items', 'uniqueItems', 'minItems', 'maxItems'],
      object: ['type', 'properties', 'required', 'additionalProperties']
    };
    requireData(Object.hasOwn(allowed, schema.type), 'capability_response_schema_invalid');
    fields(schema, allowed[schema.type], 'capability_response_schema_invalid');
    for (const [minimum, maximum] of [['minLength', 'maxLength'], ['minItems', 'maxItems'], ['minimum', 'maximum']]) {
      for (const key of [minimum, maximum]) if (schema[key] !== undefined) {
        requireData(typeof schema[key] === 'number' && Number.isFinite(schema[key])
          && (['minimum', 'maximum'].includes(key)
            || Number.isSafeInteger(schema[key]) && schema[key] >= 0 && schema[key] <= 1_000_000),
        'capability_response_schema_invalid');
      }
      requireData(schema[minimum] === undefined || schema[maximum] === undefined
        || schema[minimum] <= schema[maximum], 'capability_response_schema_invalid');
    }
    if (schema.enum !== undefined) {
      const type = schema.type === 'integer' ? 'number' : schema.type;
      requireData(Array.isArray(schema.enum) && schema.enum.length > 0
        && schema.enum.length <= (type === 'boolean' ? 2 : 4096)
        && schema.enum.every(item => typeof item === type
          && (type !== 'string' || item.length <= 2000)
          && (schema.type !== 'integer' || Number.isInteger(item))), 'capability_response_schema_invalid');
    }
    if (schema.type === 'array') {
      requireData(schema.uniqueItems === undefined || typeof schema.uniqueItems === 'boolean',
        'capability_response_schema_invalid');
      pending.push({ value: schema.items, depth: depth + 1 });
    } else if (schema.type === 'object') {
      requireData(object(schema.properties) && schema.additionalProperties === false && Array.isArray(schema.required)
        && schema.required.length <= 128
        && Object.keys(schema.properties).every(key => key.length > 0 && key.length <= 200 && !forbiddenKeys.has(key))
        && schema.required.every(key => typeof key === 'string' && Object.hasOwn(schema.properties, key)),
      'capability_response_schema_invalid');
      unique(schema.required, 'capability_response_schema_invalid');
      for (const child of Object.values(schema.properties)) pending.push({ value: child, depth: depth + 1 });
    }
  }
}
function sessionAssets(task) {
  const session = task.environment.session;
  if (session === undefined) return null;
  fields(session, ['schemaVersion', 'turns'], 'capability_session_invalid');
  requireData(session.schemaVersion === 1 && Array.isArray(session.turns)
    && session.turns.length >= 2 && session.turns.length <= 32, 'capability_session_invalid');
  for (const turn of session.turns) {
    fields(turn, ['id', 'prompt', 'thread', 'responseContract'], 'capability_session_turn_invalid');
    requireData(typeof turn.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(turn.id)
      && text(turn.prompt) && turn.prompt === turn.prompt.trim() && turn.prompt.length <= 65536
      && ['new', 'continue'].includes(turn.thread), 'capability_session_turn_invalid');
    if (turn.responseContract !== undefined) responseContract(turn.responseContract);
  }
  unique(session.turns.map(turn => turn.id), 'capability_session_turn_identity_invalid');
  requireData(session.turns[0].thread === 'new' && session.turns[0].prompt === task.visible.prompt,
    'capability_session_first_input_invalid');
  return session.turns;
}
function mcpAssets(task) {
  const mcp = task.environment.mcp;
  if (mcp === undefined) return null;
  fields(mcp, ['schemaVersion', 'mode', 'sourceFile'], 'capability_mcp_environment_invalid');
  requireData(mcp.schemaVersion === 1 && mcp.mode === 'local-records-v1', 'capability_mcp_environment_invalid');
  capabilityRelativePath(mcp.sourceFile);
  requireData(mcp.sourceFile === 'mcp-records.json', 'capability_mcp_environment_invalid');
  requireData(Object.hasOwn(task.visible.files, mcp.sourceFile), 'capability_mcp_source_missing');
  requireData(typeof task.visible.files[mcp.sourceFile] === 'string'
    && Buffer.byteLength(task.visible.files[mcp.sourceFile], 'utf8') <= 32 * 1024, 'capability_mcp_source_too_large');
  let records;
  try { records = JSON.parse(task.visible.files[mcp.sourceFile]); } catch { fail('data', 'capability_mcp_source_invalid_json'); }
  requireData(object(records) && Object.keys(records).length > 0 && Object.keys(records).every(text)
    && !hiddenJson(records), 'capability_mcp_source_invalid');
  jsonValue(records);
  requireData(task.environment.tools.includes('lookup_record'), 'capability_mcp_tool_missing');
  return records;
}
function validateTask(task, suite) {
  fields(task, ['schemaVersion', 'id', 'family', 'difficulty', 'clusterId', 'split', 'source', 'capabilityTags',
    'visible', 'environment', 'expected', 'review', 'unsupported'], 'capability_task_schema_invalid');
  requireData(task.schemaVersion === 2 && text(task.id) && text(task.family) && text(task.clusterId)
    && text(task.difficulty)
    && ['fixture', 'development', 'holdout', 'release'].includes(task.split), 'capability_task_identity_invalid');
  capabilityRelativePath(task.id);
  requireData(!task.id.includes('/') && task.id === task.id.trim(), 'capability_task_identity_path_invalid');
  const families = suite === 'roc-e2e-research' ? Object.keys(e2eFamilyQuotas)
    : suite === 'roc-security' ? ['security-permission-injection'] : capabilityFamilies;
  requireData(families.includes(task.family), 'capability_task_family_invalid');
  requireData(Array.isArray(task.capabilityTags) && task.capabilityTags.every(text), 'capability_tags_invalid');
  unique(task.capabilityTags, 'capability_duplicate_tag');
  fields(task.source, ['dataset', 'revision', 'originalTaskId', 'license', 'attribution', 'contentSha256'],
    'capability_source_invalid');
  requireData(['dataset', 'revision', 'originalTaskId', 'license', 'attribution'].every(key => text(task.source[key]))
    && digest(task.source.contentSha256), 'capability_source_pin_required');
  requireData(task.unsupported === undefined || task.unsupported === null || text(task.unsupported),
    'capability_unsupported_reason_invalid');
  fields(task.environment, ['tools', 'network', 'research', 'execution', 'session', 'mcp', 'context'], 'capability_environment_invalid');
  requireData(Array.isArray(task.environment.tools) && task.environment.tools.length > 0
    && task.environment.tools.every(text) && task.environment.network === 'disabled', 'capability_environment_invalid');
  unique(task.environment.tools, 'capability_duplicate_tool');
  fields(task.expected, ['checks', 'answer', 'safety'], 'capability_expected_invalid');
  requireData(Array.isArray(task.expected.checks) && task.expected.checks.length > 0
    && task.expected.checks.some(check => check.required !== false), 'capability_ground_truth_missing');
  const turns = sessionAssets(task), records = mcpAssets(task);
  if (task.environment.context !== undefined) {
    fields(task.environment.context, ['schemaVersion', 'contextWindowTokens'], 'capability_context_environment_invalid');
    requireData(task.environment.context.schemaVersion === 1
      && Number.isSafeInteger(task.environment.context.contextWindowTokens)
      && task.environment.context.contextWindowTokens >= 8192, 'capability_context_environment_invalid');
  }
  visibleBoundary(task);
  const documents = researchAssets(task), execution = executionAssets(task);
  const reasons = [];
  if (task.unsupported) reasons.push(...task.unsupported.split(';'));
  if (unsupportedFamilies[task.family]) reasons.push(unsupportedFamilies[task.family]);
  for (const name of task.environment.tools) {
    if (!capabilityProductionTools.includes(name)) reasons.push(`production_tool_not_exposed:${name}`);
    else if (complexTools.has(name)) reasons.push('production_cross_session_compaction_evidence_unavailable');
  }
  const ids = [];
  for (const check of task.expected.checks) {
    requireData(object(check) && text(check.id) && text(check.kind)
      && (check.required === undefined || typeof check.required === 'boolean'), 'capability_check_invalid');
    ids.push(check.id);
    requireData(check.inputFor === undefined || turns?.some(turn => turn.id === check.inputFor),
      'capability_check_input_phase_invalid');
    if (!kinds.has(check.kind)) { reasons.push(`production_check_evidence_unavailable:${check.kind}`); continue; }
    if (check.kind === 'json-value') {
      outputPath(check.path);
      requireData(Object.hasOwn(check, 'value'), 'capability_json_ground_truth_missing');
    } else if (check.kind === 'tool-call') {
      requireData(text(check.name) && (check.args === undefined || object(check.args))
        && Number.isSafeInteger(check.min ?? 1) && (check.min ?? 1) >= 0
        && (check.max === undefined || Number.isSafeInteger(check.max) && check.max >= (check.min ?? 1)),
      'capability_tool_check_invalid');
      requireData(task.environment.tools.includes(check.name), 'capability_check_tool_not_in_environment');
      for (const key of ['file_path', 'path']) if (check.args?.[key] !== undefined) workspacePath(check.args[key]);
      if (check.name === 'run_shell_command' && check.args?.command !== undefined) {
        requireData(check.args.command === 'python solution.py', 'capability_execution_command_invalid');
      }
    } else if (check.kind === 'memory' || check.kind === 'stateful') {
      fields(check, ['id', 'kind', 'required', 'inputFor', 'sourcePhase',
        ...(check.kind === 'memory' ? ['key', 'scope'] : [])], 'capability_session_check_invalid');
      requireData(text(check.sourcePhase), 'capability_session_source_phase_required');
      if (check.kind === 'memory') {
        requireData(text(check.key) && (check.scope === undefined || ['global', 'workspace'].includes(check.scope)),
          'capability_memory_check_invalid');
      }
      if (!turns) reasons.push(`production_check_evidence_unavailable:${check.kind}:session_missing`);
      else {
        const sourceIndex = turns.findIndex(turn => turn.id === check.sourcePhase);
        const targetIndex = check.inputFor === undefined ? turns.length - 1
          : turns.findIndex(turn => turn.id === check.inputFor);
        requireData(sourceIndex >= 0 && sourceIndex < targetIndex, 'capability_session_source_phase_invalid');
        const crossesSession = turns.slice(sourceIndex + 1, targetIndex + 1).some(turn => turn.thread === 'new');
        requireData(check.kind === 'memory' ? crossesSession
          : !crossesSession && turns[targetIndex].thread === 'continue', 'capability_session_thread_evidence_invalid');
        if (check.kind === 'memory'
          && !['remember', 'memory_search'].every(name => task.environment.tools.includes(name))) {
          reasons.push('production_memory_write_search_tools_required');
        }
      }
    } else if (check.kind === 'mcp') {
      fields(check, ['id', 'kind', 'required', 'inputFor', 'name', 'args', 'value', 'min', 'max'],
        'capability_mcp_check_invalid');
      requireData(check.name === 'lookup_record' && object(check.args)
        && Object.keys(check.args).length === 1 && text(check.args.key) && [...check.args.key].length <= 128
        && Number.isSafeInteger(check.min ?? 1) && (check.min ?? 1) >= 0
        && (check.max === undefined || Number.isSafeInteger(check.max) && check.max >= (check.min ?? 1)),
      'capability_mcp_check_invalid');
      if (!records) reasons.push('production_check_evidence_unavailable:mcp:environment_missing');
      else if (Object.hasOwn(check, 'value')) {
        requireData(hash(check.value) === hash(Object.hasOwn(records, check.args.key) ? records[check.args.key] : null),
          'capability_mcp_ground_truth_mismatch');
      }
    } else if (check.kind === 'context') {
      fields(check, ['id', 'kind', 'required', 'stage', 'sourcePhase', 'inputFor', 'filePath', 'includes'],
        'capability_context_check_invalid');
      requireData(['summary', 'tool-offload'].includes(check.stage)
        && (check.includes === undefined || Array.isArray(check.includes) && check.includes.length > 0
          && check.includes.every(text)), 'capability_context_check_invalid');
      if (check.filePath !== undefined) {
        capabilityRelativePath(check.filePath);
        requireData(Object.hasOwn(task.visible.files, check.filePath), 'capability_context_source_mapping_required');
      }
      if (check.sourcePhase !== undefined) {
        const sourceIndex = turns?.findIndex(turn => turn.id === check.sourcePhase) ?? -1;
        const targetIndex = check.inputFor === undefined ? (turns?.length ?? 0) - 1
          : turns?.findIndex(turn => turn.id === check.inputFor) ?? -1;
        requireData(sourceIndex >= 0 && sourceIndex < targetIndex, 'capability_session_source_phase_invalid');
      }
      if (check.stage === 'summary' && !turns) reasons.push('production_context_summary_session_required');
      if (check.stage === 'tool-offload') {
        requireData(text(check.filePath), 'capability_context_offload_file_required');
        requireData(task.environment.tools.includes('read_context_artifact'), 'capability_context_offload_tool_required');
      }
      // The independent runtime/grader still requires the actual summary or
      // offload event and its bound wire, artifact, checkpoint and usage evidence.
    } else if (check.kind === 'file') artifact(check);
    else if (check.kind === 'execution') {
      capabilityRelativePath(check.entrypoint);
      if (check.entrypoint !== 'solution.py') reasons.push('production_execution_entrypoint_unsupported');
      requireData(Array.isArray(check.outputFiles) && check.outputFiles.length > 0, 'capability_execution_outputs_missing');
      check.outputFiles.forEach(file => artifact(file, { allowExistence: true }));
      unique(check.outputFiles.map(file => typeof file === 'string' ? file : file.path), 'capability_execution_output_duplicate');
      if (!execution || !task.environment.tools.includes('run_shell_command')) reasons.push('fixed_python_environment_lock_missing');
    } else if (check.kind === 'citation') {
      requireData(text(check.sourceId), 'capability_citation_source_required');
      if (check.path !== undefined) outputPath(check.path);
      requireData(check.quote === undefined || text(check.quote), 'capability_citation_quote_invalid');
      let content;
      if (check.filePath !== undefined) {
        capabilityRelativePath(check.filePath);
        requireData(Object.hasOwn(task.visible.files, check.filePath), 'capability_citation_file_missing');
        content = task.visible.files[check.filePath];
        requireData(check.sourceVersion === undefined || check.sourceVersion === sha256(content),
          'capability_citation_version_mismatch');
      } else {
        const document = documents?.find(value => value.sourceId === check.sourceId && value.current
          && (check.sourceVersion === undefined || value.sourceVersion === check.sourceVersion));
        if (!document) reasons.push('production_citation_source_evidence_unavailable');
        else {
          content = document.content;
          requireData(check.sourceSha256 === undefined || check.sourceSha256 === document.contentSha256,
            'capability_citation_source_hash_mismatch');
        }
      }
      if (content !== undefined) {
        const start = check.startOffset, end = check.endOffset;
        requireData(start === undefined && end === undefined || Number.isSafeInteger(start) && Number.isSafeInteger(end)
          && start >= 0 && end > start && end <= (check.filePath === undefined ? content.length : Buffer.byteLength(content)),
        'capability_citation_span_invalid');
        const span = start === undefined ? content : check.filePath === undefined
          ? content.slice(start, end) : Buffer.from(content).subarray(start, end).toString('utf8');
        requireData(check.quote === undefined || span.includes(check.quote), 'capability_citation_quote_not_in_source');
      }
    }
  }
  unique(ids, 'capability_duplicate_check');
  if (task.environment.tools.includes('run_shell_command') && !execution) reasons.push('fixed_python_environment_lock_missing');
  if (task.environment.tools.some(name => name.startsWith('research_')) && !documents) {
    reasons.push('production_research_corpus_missing');
  }
  const required = task.expected.checks.filter(check => check.required !== false);
  const memory = Boolean(turns && required.some(check => check.kind === 'memory')
    && ['remember', 'memory_search'].every(name => task.environment.tools.includes(name)));
  const context = required.some(check => check.kind === 'context'
    && (check.stage === 'summary' && turns || check.stage === 'tool-offload'
      && task.environment.tools.includes('read_context_artifact')));
  const stateful = Boolean(turns && required.some(check => check.kind === 'stateful'));
  const mcp = Boolean(records && required.some(check => check.kind === 'mcp' && (check.min ?? 1) > 0));
  if (task.family === 'memory-context-compaction' && !memory && !context) {
    reasons.push('production_memory_or_context_evidence_unavailable');
  }
  if (task.family === 'stateful-multi-turn-clarification' && !stateful) {
    reasons.push('production_multi_turn_clarification_evidence_unavailable');
  }
  if (task.family === 'mcp-interaction-recovery' && !mcp) reasons.push('production_mcp_protocol_evidence_unavailable');
  if (task.environment.tools.some(name => ['remember', 'memory_search'].includes(name)) && !memory && !context) {
    reasons.push('production_cross_session_memory_evidence_unavailable');
  }
  if (task.environment.tools.includes('read_context_artifact') && !context) {
    reasons.push('production_context_artifact_evidence_unavailable');
  }
  if (task.environment.tools.includes('lookup_record') && !mcp) reasons.push('production_mcp_protocol_evidence_unavailable');
  if (task.family === 'tool-selection-arguments' && !required.some(check => check.kind === 'tool-call')) {
    reasons.push('production_tool_call_evidence_required');
  }
  if (['file-report-artifact', 'security-permission-injection'].includes(task.family)
    && !required.some(check => check.kind === 'file')) reasons.push('production_file_artifact_evidence_required');
  if (['literature-verification', 'multi-paper-evidence-citation', 'literature-research'].includes(task.family)
    && !required.some(check => check.kind === 'citation' || check.kind === 'tool-call'
      && ['read_file', 'research_read_knowledge_context'].includes(check.name))) reasons.push('production_literature_read_evidence_required');
  if (task.family === 'multi-paper-evidence-citation'
    && new Set(required.filter(check => check.kind === 'citation').map(check => check.sourceId)).size < 2) {
    reasons.push('production_multi_paper_citation_evidence_required');
  }
  if (['experiment-code-execution', 'experiment-reproduction'].includes(task.family)
    && !required.some(check => check.kind === 'execution')) {
    reasons.push('production_execution_evidence_required');
  }
  if (task.expected.safety !== undefined) {
    fields(task.expected.safety, ['sensitiveValues', 'hiddenValues', 'prohibitedPaths', 'approvalRequiredTools'],
      'capability_safety_invalid');
    for (const [key, values] of Object.entries(task.expected.safety)) {
      requireData(Array.isArray(values) && values.every(text), 'capability_safety_invalid');
      if (key === 'prohibitedPaths') values.forEach(capabilityRelativePath);
    }
    const visible = JSON.stringify({ visible: task.visible, environment: task.environment });
    for (const value of task.expected.safety.hiddenValues ?? []) {
      requireData(!visible.includes(value), 'capability_hidden_truth_leakage');
    }
  }
  const review = reviewState(task);
  if (task.source.dataset === 'roc-engineering-fixture') {
    requireData(task.split === 'fixture'
      && task.source.license === 'LicenseRef-Roc-Local-Engineering'
      && task.source.originalTaskId === task.id
      && task.source.contentSha256 === capabilityFixtureSourceHash(task)
      && task.source.revision === `sha256:${task.source.contentSha256}`, 'capability_fixture_source_mismatch');
  }
  return { task: { ...task, ...(reasons.length ? { unsupported: [...new Set(reasons)].join(';') } : {}) }, review, documents };
}
function checkClusters(values, byTask) {
  const parents = new Map(), splits = new Map();
  const find = key => {
    if (!parents.has(key)) parents.set(key, key);
    if (parents.get(key) !== key) parents.set(key, find(parents.get(key)));
    return parents.get(key);
  };
  const keysFor = value => [`cluster:${value.task.clusterId}`, ...(byTask.get(value.task.id)?.clusterKeys ?? []),
    ...(value.documents ?? []).map(document => `research-source:${document.sourceId}`)];
  for (const value of values) {
    const keys = keysFor(value);
    for (const key of keys) parents.set(find(key), find(keys[0]));
  }
  // The union representative depends on insertion order. Derive an opaque
  // identity from sorted actual source keys instead; task labels only supply
  // conservative union edges and the fallback for source-free fixtures.
  const components = new Map(), identities = new Map();
  for (const key of parents.keys()) {
    const root = find(key);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(key);
  }
  for (const [root, keys] of components) {
    const sourceKeys = keys.filter(key => !key.startsWith('cluster:'));
    identities.set(root, `source-connected-${hash((sourceKeys.length ? sourceKeys : keys).sort())}`);
  }
  const roots = new Map();
  for (const value of values) {
    const cluster = find(keysFor(value)[0]), previous = splits.get(cluster);
    requireData(previous === undefined || previous === value.task.split, 'capability_cross_split_source_cluster_overlap');
    splits.set(cluster, value.task.split);
    roots.set(value.task.id, identities.get(cluster));
  }
  return roots;
}
function evaluate(suite, tasks, provenance, root, sourceEvidence) {
  requireData(capabilitySuites.includes(suite) && Array.isArray(tasks) && tasks.length > 0, 'capability_dataset_invalid');
  jsonValue(tasks);
  const values = tasks.map(task => validateTask(task, suite));
  unique(tasks.map(task => identity(task.id)), 'capability_duplicate_task_identity');
  unique(tasks.map(task => `${task.source.dataset}\0${task.source.originalTaskId}`), 'capability_duplicate_original_identity');
  const imported = tasks.some(task => task.source.dataset !== 'roc-engineering-fixture');
  requireData(!imported || root && sourceEvidence, 'capability_source_originals_required');
  const byTask = root && sourceEvidence ? verifyCapabilitySources(root, sourceEvidence, tasks) : new Map();
  const sourceRoots = checkClusters(values, byTask);
  requireData(object(provenance) && ['engineering_fixture', 'local_source_import', 'human_reviewed'].includes(provenance.kind),
    'capability_provenance_kind_unverified');
  const quotas = suite === 'roc-e2e-research' ? e2eFamilyQuotas : suite === 'roc-security'
    ? { 'security-permission-injection': capabilityFamilyQuotas['security-permission-injection'] } : capabilityFamilyQuotas;
  const familyCounts = Object.fromEntries(Object.keys(quotas).map(family => [family, {
    quota: quotas[family], definitions: 0, fixture: 0, development: 0, holdout: 0, release: 0,
    qualifiedHoldout: 0, qualifiedRelease: 0, qualifiedHoldoutClusters: 0, qualifiedReleaseClusters: 0
  }]));
  const qualifiedClusters = Object.fromEntries(Object.keys(quotas).map(family =>
    [family, { holdout: new Set(), release: new Set() }]));
  const details = values.map(value => {
    const task = value.task, source = byTask.get(task.id), fixture = task.split === 'fixture';
    const qualified = !fixture && !task.unsupported && provenance.kind === 'human_reviewed'
      && value.review.accepted && source?.upstreamVerified === true
      && source.scientificQuality !== false;
    const count = familyCounts[task.family];
    count.definitions++; count[task.split]++;
    if (task.split === 'holdout' && qualified) {
      count.qualifiedHoldout++; qualifiedClusters[task.family].holdout.add(sourceRoots.get(task.id));
    }
    if (task.split === 'release' && qualified) {
      count.qualifiedRelease++; qualifiedClusters[task.family].release.add(sourceRoots.get(task.id));
    }
    return { id: task.id, contentHash: value.review.contentHash, review: value.review.status, fixture,
      split: task.split, family: task.family, clusterId: task.clusterId,
      sourceConnectedRoot: sourceRoots.get(task.id),
      sourcePinned: fixture || Boolean(source), upstreamVerified: source?.upstreamVerified === true,
      scientificQuality: source?.scientificQuality ?? null, supported: !task.unsupported,
      unsupported: task.unsupported ?? null, qualified };
  });
  for (const [family, count] of Object.entries(familyCounts)) {
    count.qualifiedHoldoutClusters = qualifiedClusters[family].holdout.size;
    count.qualifiedReleaseClusters = qualifiedClusters[family].release.size;
    requireData(count.holdout <= count.quota, 'capability_holdout_family_quota_exceeded');
    requireData(count.release <= count.quota, 'capability_release_family_quota_exceeded');
  }
  const verified = details.every(value => value.qualified);
  const holdoutReady = Object.values(familyCounts).every(count => count.qualifiedHoldout === count.quota
    && (suite !== 'roc-e2e-research' || count.qualifiedHoldoutClusters >= count.quota));
  const releaseDatasetReady = Object.values(familyCounts).every(count => count.qualifiedRelease === count.quota
    && (suite !== 'roc-e2e-research' || count.qualifiedReleaseClusters >= count.quota));
  const summary = {
    schemaVersion: 2, kind: 'pinned-source-reviewed-capability-v2', specStatus: 'Draft',
    status: verified ? 'verified' : details.every(value => value.fixture) ? 'engineering' : 'pending',
    holdoutReady, holdoutDatasetReady: holdoutReady, fullDatasetReady: holdoutReady, releaseDatasetReady,
    suite, total: tasks.length, supported: values.filter(value => !value.task.unsupported).length,
    engineeringOnly: !verified, humanReviewAsserted: provenance.kind === 'human_reviewed',
    review: { reviewed: details.filter(value => value.review === 'reviewed').length,
      draft: details.filter(value => value.review === 'draft').length,
      rejected: details.filter(value => value.review === 'rejected').length },
    familyCounts, missingHoldout: Object.fromEntries(Object.entries(familyCounts)
      .map(([family, count]) => [family, count.quota - count.qualifiedHoldout])),
    missingRelease: Object.fromEntries(Object.entries(familyCounts)
      .map(([family, count]) => [family, count.quota - count.qualifiedRelease])),
    ...(suite === 'roc-e2e-research' ? {
      missingHoldoutClusters: Object.fromEntries(Object.entries(familyCounts)
        .map(([family, count]) => [family, Math.max(0, count.quota - count.qualifiedHoldoutClusters)])),
      missingReleaseClusters: Object.fromEntries(Object.entries(familyCounts)
        .map(([family, count]) => [family, Math.max(0, count.quota - count.qualifiedReleaseClusters)]))
    } : {}),
    tasks: details,
    reason: verified ? null : 'Fixtures, local byte pins, Draft reviews and unsupported evidence cannot establish full benchmark quality.',
    sourceEvidenceHash: sourceEvidence ? hash(sourceEvidence) : null,
    policyHash: hash(registry.qualificationPolicy), registryHash: hash(registry)
  };
  return { tasks: values.map(value => value.task), qualification: { ...summary, hash: hash(summary) } };
}

/**
 * Rehash the sealed directory and replay original mappings on every validation.
 * The returned object is also attached to the supplied loadDataset result, as
 * existing runner callers intentionally ignore this function's return value.
 */
export function validateCapabilityDataset(dataset) {
  requireData(object(dataset) && text(dataset.root) && object(dataset.manifest), 'capability_sealed_dataset_required');
  requireData(!lstatSync(dataset.root).isSymbolicLink(), 'capability_dataset_symlink');
  const fresh = loadDataset(dataset.root);
  requireData(hash(dataset.manifest) === hash(fresh.manifest) && hash(dataset.tasks) === hash(fresh.tasks),
    'capability_loaded_dataset_changed');
  requireData(fresh.manifest.schemaVersion === 1 && capabilitySuites.includes(fresh.manifest.suite)
    && fresh.manifest.total === fresh.tasks.length, 'capability_dataset_manifest_invalid');
  const sourceEvidence = readJson(join(fresh.root, evidenceFile));
  requireData(sha256(readFileSync(join(fresh.root, evidenceFile))) === fresh.manifest.provenance.sourceEvidenceSha256,
    'capability_source_evidence_hash_mismatch');
  const result = evaluate(fresh.manifest.suite, fresh.tasks, fresh.manifest.provenance, fresh.root, sourceEvidence);
  requireData(hash(result.tasks) === hash(fresh.tasks) && result.qualification.supported === fresh.manifest.supported,
    'capability_sealed_support_semantics_changed');
  const payload = { ...result.qualification, datasetIdentity: fresh.manifest.identity };
  const { hash: previousHash, ...qualification } = payload;
  dataset.tasks = result.tasks;
  dataset.capabilityQualification = { ...qualification, hash: hash(qualification) };
  dataset.datasetQualification = dataset.capabilityQualification;
  return dataset;
}
export function capabilityReadiness(dataset) {
  validateCapabilityDataset(dataset);
  return structuredClone(dataset.capabilityQualification);
}

/**
 * Input: {schemaVersion:2,suite?,provenance?,tasks?:Task[],imports?:SourceSpec[]}.
 * A JSON path resolves local import roots relative to that file. A plain object
 * resolves them relative to cwd. Imported originals/mappings remain controller
 * files; only Task.visible is passed to the runtime.
 *
 * Fixture:
 *   prepareCapabilityDataset(capabilityEngineeringDataset(suite, {pythonEnvironment}), {suite, cacheRoot})
 * Local originals:
 *   prepareCapabilityDataset({schemaVersion:2, suite, imports:[sourceSpec]}, {suite, cacheRoot})
 * QASPER:
 *   imports:[{dataset:'qasper',datasetPath:'/absolute/sealed-qasper',
 *     mappings:[{originalTaskId:'actual-question-id',task?:TaskTemplate}]}]
 * Human review is supplied only as real attestations in each task template's
 * review field, with provenance.kind='human_reviewed'. Preparation never adds it.
 *
 * capabilityReadiness(loadDataset(path)) independently exposes
 * holdoutDatasetReady (aliases holdoutReady/fullDatasetReady) and
 * releaseDatasetReady, familyCounts.qualifiedHoldout/qualifiedRelease, and
 * missingHoldout/missingRelease. Each split needs its own qualified quotas;
 * fixture/development tasks do not count toward either formal split.
 */
export async function prepareCapabilityDataset(inputPathOrObject, { suite, cacheRoot = CACHE } = {}) {
  const fromFile = typeof inputPathOrObject === 'string';
  const bytes = fromFile ? readFileSync(inputPathOrObject) : Buffer.from(JSON.stringify(inputPathOrObject));
  const input = JSON.parse(bytes);
  requireData(object(input) && input.schemaVersion === 2, 'capability_corpus_schema_invalid');
  suite ??= input.suite;
  requireData(capabilitySuites.includes(suite) && (input.suite === undefined || input.suite === suite),
    'capability_dataset_suite_invalid');
  requireData(input.tasks === undefined || Array.isArray(input.tasks), 'capability_dataset_tasks_invalid');
  const imports = input.imports === undefined ? null : importCapabilitySources(input.imports,
    { baseDir: fromFile ? dirname(resolve(inputPathOrObject)) : process.cwd() });
  const tasks = [...(input.tasks ?? []), ...(imports?.tasks ?? [])];
  const sourceEvidence = imports?.sourceEvidence ?? { schemaVersion: 1, sources: [] };
  const suppliedProvenance = input.provenance ?? { kind: imports ? 'local_source_import' : 'engineering_fixture' };
  const provenance = { ...suppliedProvenance, specStatus: 'Draft', adaptation: registry.adaptation,
    split: 'source-connected-component', inputSha256: sha256(bytes) };
  const stage = directory(resolve(cacheRoot), `preparing-${suite}`);
  let sealed;
  try {
    for (const [path, content] of Object.entries(imports?.controlFiles ?? {})) {
      capabilityRelativePath(path);
      const target = join(stage, path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, content, { flag: 'wx', mode: 0o600 });
    }
    writeJson(join(stage, evidenceFile), sourceEvidence);
    provenance.sourceEvidenceSha256 = sha256(readFileSync(join(stage, evidenceFile)));
    const result = evaluate(suite, tasks, provenance, stage, sourceEvidence);
    provenance.review = result.qualification.review;
    sealed = sealDataset(stage, suite, provenance, result.tasks, resolve(cacheRoot));
    validateCapabilityDataset(loadDataset(sealed));
    return sealed;
  } finally {
    // sealDataset moves staging atomically. Never remove an existing sealed
    // cache or another process's preparation directory on failure.
    rmSync(stage, { recursive: true, force: true });
  }
}
