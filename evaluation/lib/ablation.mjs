import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { fail, hash, sha256 } from './common.mjs';
import { assertPreExecutionClaim, assertPreregistrationTiming, assertSealedRun, assessAcceptance, comparisonEvidence,
  digest, experimentComparisonFields, experimentSpecFields, inspectProtocolRun, isCapabilitySuite, pairedComparison,
  readComparisonProtocol, readProtocolRecord, text, toolSchemaContract, validTaskToolManifests,
  validToolManifest, validateAcceptance } from './comparison.mjs';

const jsonObject = z.record(z.string(), z.json());
const globalCapabilities = z.strictObject({
  toolManifest: jsonObject.refine(value => validToolManifest(value)), toolSchemaHash: digest
});
const taskCapabilities = z.strictObject({
  toolManifest: jsonObject.refine(value => validToolManifest(value, { allowEmpty: true })),
  taskToolManifests: z.array(z.strictObject({
    taskId: text, manifest: jsonObject.refine(value => validToolManifest(value, { allowEmpty: true }))
  })).min(1),
  taskToolSchemaHashes: z.record(text, digest)
});
const capabilities = z.union([globalCapabilities, taskCapabilities]);
export const ablationSpecSchema = z.strictObject({
  ...experimentSpecFields, kind: z.literal('ablation'),
  ablation: z.strictObject({
    retrievalConfig: z.strictObject({ baseline: jsonObject, candidate: jsonObject }).optional(),
    capabilities: z.strictObject({ baseline: capabilities, candidate: capabilities }).optional()
  }).refine(value => Boolean(value.retrievalConfig || value.capabilities), { message: 'ablation_difference_required' })
}).refine(spec => Boolean(spec.acceptance.primaryMetrics?.length), { message: 'ablation_primary_metric_required' })
  .refine(spec => Object.keys(spec.acceptance.resourceCeilings ?? {}).length
    + Object.keys(spec.acceptance.maxResourceDegradation ?? {}).length > 0, { message: 'ablation_resource_gate_required' });

function outerToolContract(manifest) {
  const { tools, manifestHash, ...outer } = manifest;
  // manifestHash is derived from the complete production manifest, including tools.
  // Production uses insertion-order JSON, so preserve its original property order.
  const { manifestHash: omitted, ...original } = manifest;
  if (manifestHash !== undefined && manifestHash !== sha256(JSON.stringify(original))) fail('policy', 'ablation_tool_manifest_hash_invalid');
  return outer;
}
function toolPolicy(tool) {
  // Only descriptions, versions and schema bindings may vary on a shared tool.
  // Unknown metadata remains frozen, including effects, approval and scope.
  const { description, toolVersion, schema, schemaHash, inputSchema, outputSchema, parameters, mcpContract, ...policy } = tool;
  if (mcpContract) {
    const { schemaHash: omittedSchema, descriptionHash, inputSchema: omittedInput, outputSchema: omittedOutput, ...binding } = mcpContract;
    policy.mcpContract = binding;
  }
  return policy;
}
function validateTaskCapabilities(arm, seedManifest) {
  if (!arm.taskToolManifests || !arm.taskToolSchemaHashes) fail('policy', 'per_task_tool_ablation_declaration_required');
  if (!validTaskToolManifests({ selection: seedManifest.selection, ...arm })) {
    fail('policy', 'ablation_task_tool_manifest_union_or_selection_mismatch');
  }
  if (hash(Object.keys(arm.taskToolSchemaHashes).sort()) !== hash(seedManifest.selection.map(task => task.id).sort())) {
    fail('policy', 'ablation_task_tool_schemas_incomplete');
  }
  const seedTools = new Map(seedManifest.taskToolManifests.map(entry => [entry.taskId, entry.manifest]));
  for (const entry of arm.taskToolManifests) {
    const original = seedTools.get(entry.taskId);
    if (hash(outerToolContract(entry.manifest)) !== hash(outerToolContract(original))) {
      fail('policy', `ablation_task_outer_tool_contract_changed:${entry.taskId}`);
    }
    const allowed = new Map(original.tools.map(tool => [tool.modelVisibleName, tool]));
    for (const tool of entry.manifest.tools) {
      if (!allowed.has(tool.modelVisibleName)) fail('policy', `ablation_task_tool_not_in_seed:${entry.taskId}:${tool.modelVisibleName}`);
      if (hash(toolPolicy(allowed.get(tool.modelVisibleName))) !== hash(toolPolicy(tool))) {
        fail('policy', `ablation_tool_policy_changed:${tool.modelVisibleName}`);
      }
    }
  }
}
export function validateAblationSpec(spec, seedManifest) {
  spec = ablationSpecSchema.parse(spec);
  validateAcceptance(spec, seedManifest.metrics);
  const perTask = isCapabilitySuite(seedManifest.suite);
  if (!validToolManifest(seedManifest.toolManifest, { allowEmpty: perTask })) fail('policy', 'tool_contract_evidence_missing');
  if (perTask && !validTaskToolManifests(seedManifest)) fail('policy', 'task_tool_contract_evidence_missing');
  if (seedManifest.permissions === undefined || seedManifest.permissions === null) fail('policy', 'ablation_permissions_contract_required');
  const declaration = spec.ablation;
  // These suites derive retrieval from the sealed task environment. The global
  // RAG ablation options do not change that environment or its actual execution.
  if (perTask && declaration.retrievalConfig) {
    fail('policy', 'per_task_retrieval_ablation_requires_separate_preregistered_protocol');
  }
  if (declaration.retrievalConfig
    && hash(declaration.retrievalConfig.baseline) === hash(declaration.retrievalConfig.candidate)) {
    fail('policy', 'ablation_retrieval_difference_required');
  }
  if (declaration.capabilities) {
    const before = declaration.capabilities.baseline, after = declaration.capabilities.candidate;
    if (hash(before) === hash(after)) fail('policy', 'ablation_capability_difference_required');
    if (perTask) {
      validateTaskCapabilities(before, seedManifest);
      validateTaskCapabilities(after, seedManifest);
    } else if (before.taskToolManifests || after.taskToolManifests) {
      fail('policy', 'per_task_tool_ablation_requires_capability_suite');
    }
    const outer = outerToolContract(seedManifest.toolManifest);
    for (const arm of [before, after]) {
      if (hash(outerToolContract(arm.toolManifest)) !== hash(outer)) fail('policy', 'ablation_outer_tool_contract_changed');
    }
    const manifests = [seedManifest.toolManifest, before.toolManifest, after.toolManifest];
    for (let i = 0; i < manifests.length; i++) for (let j = i + 1; j < manifests.length; j++) {
      const left = new Map(manifests[i].tools.map(tool => [tool.modelVisibleName, tool]));
      for (const tool of manifests[j].tools) {
        if (left.has(tool.modelVisibleName) && hash(toolPolicy(left.get(tool.modelVisibleName))) !== hash(toolPolicy(tool))) {
          fail('policy', `ablation_tool_policy_changed:${tool.modelVisibleName}`);
        }
      }
    }
  }
  return spec;
}
export function ablationArmContract(protocol, seedManifest, arm) {
  if (!['baseline', 'candidate'].includes(arm)) fail('policy', 'experiment_arm_required');
  const declaration = protocol.spec.ablation;
  const fields = Object.fromEntries(experimentComparisonFields(seedManifest).map(key => [key, seedManifest[key] ?? null]));
  if (declaration.retrievalConfig) fields.retrievalConfig = declaration.retrievalConfig[arm];
  if (declaration.capabilities) fields.toolManifest = declaration.capabilities[arm].toolManifest;
  if (isCapabilitySuite(seedManifest.suite) && declaration.capabilities) {
    fields.taskToolManifests = declaration.capabilities[arm].taskToolManifests;
  }
  return { fields, ...(isCapabilitySuite(seedManifest.suite) ? { source: protocol.candidateSource,
    taskToolSchemaHashes: declaration.capabilities?.[arm].taskToolSchemaHashes ?? protocol.taskToolSchemaHashes }
    : { toolSchemaHash: declaration.capabilities?.[arm].toolSchemaHash ?? protocol.toolSchemaHash }) };
}
export function assertAblationManifest(protocol, seedManifest, manifest, arm, { partial = false } = {}) {
  const expected = ablationArmContract(protocol, seedManifest, arm);
  const initial = ['suite', 'profile', 'evidence', 'repeats', 'split', 'metrics', 'scorerHash', 'applicationContract'];
  for (const key of partial ? initial : experimentComparisonFields(seedManifest)) {
    if (hash(manifest[key] ?? null) !== hash(expected.fields[key])) fail('policy', `experiment_contract_mismatch:${key}`);
  }
  if (partial) for (const key of ['retrievalConfig', 'toolManifest', 'taskToolManifests', 'permissions', 'ragContract']) {
    if (manifest[key] !== undefined && manifest[key] !== null && hash(manifest[key]) !== hash(expected.fields[key])) {
      fail('policy', `experiment_contract_mismatch:${key}`);
    }
  }
  if (manifest.source?.sourceHash !== protocol.candidateSource.sourceHash) fail('state', 'experiment_candidate_source_changed');
  if (isCapabilitySuite(seedManifest.suite) && hash(manifest.source) !== hash(protocol.candidateSource)) {
    fail('state', 'experiment_candidate_source_changed');
  }
  return expected;
}
export function assertAblationProtocol(context, baseline, candidate) {
  const { path, protocol } = context;
  if (protocol.comparisonProtocolVersion !== 1 || protocol.spec.kind !== 'ablation') fail('policy', 'ablation_preregistration_missing');
  const seed = inspectProtocolRun(protocol.baseline);
  validateAblationSpec(protocol.spec, seed.manifest);
  if (isCapabilitySuite(seed.manifest.suite)
    && hash(toolSchemaContract(seed).taskToolSchemaHashes) !== hash(protocol.taskToolSchemaHashes ?? null)) {
    fail('state', 'experiment_task_tool_schemas_changed');
  }
  assertSealedRun(baseline); assertSealedRun(candidate);
  const runs = { baseline, candidate }, contracts = {};
  for (const arm of ['baseline', 'candidate']) {
    const run = runs[arm], claim = readProtocolRecord(join(path, `${arm}.json`), arm);
    const binding = run.manifest.experiment;
    if (claim.claimVersion !== 1 || claim.arm !== arm || claim.protocolHash !== protocol.recordHash || claim.path !== realpathSync(run.path)
      || binding?.arm !== arm || binding.path !== path || binding.protocolHash !== protocol.recordHash
      || realpathSync(run.path) === realpathSync(protocol.baseline.path)) fail('state', 'ablation_run_binding_changed');
    assertPreExecutionClaim(claim, run);
    if (isCapabilitySuite(seed.manifest.suite)) assertPreregistrationTiming(protocol, claim, run);
    contracts[arm] = assertAblationManifest(protocol, seed.manifest, run.manifest, arm);
    if (claim.sourceHash !== protocol.candidateSource.sourceHash || claim.contractHash !== hash(contracts[arm].fields)) {
      fail('state', 'ablation_claim_contract_changed');
    }
  }
  if (realpathSync(baseline.path) === realpathSync(candidate.path)) fail('policy', 'ablation_arms_require_distinct_fresh_runs');
  return { seed, contracts };
}
export function compareAblation(baseline, candidate, { margin, protocol: reference } = {}) {
  const context = readComparisonProtocol(reference), { protocol } = context;
  if (margin !== undefined && margin !== protocol.spec.acceptance.nonInferiorityMargin) fail('policy', 'comparison_protocol_margin_mismatch');
  const { contracts } = assertAblationProtocol(context, baseline, candidate);
  const declaration = protocol.spec.ablation;
  const allowedFields = [declaration.retrievalConfig ? 'retrievalConfig' : null,
    declaration.capabilities ? 'toolManifest' : null,
    declaration.capabilities && isCapabilitySuite(baseline.manifest.suite) ? 'taskToolManifests' : null].filter(Boolean);
  const comparison = pairedComparison(comparisonEvidence(baseline, candidate, {
    allowedFields, schemaHashes: [contracts.baseline.toolSchemaHash, contracts.candidate.toolSchemaHash],
    taskSchemaHashes: isCapabilitySuite(baseline.manifest.suite)
      ? [contracts.baseline.taskToolSchemaHashes, contracts.candidate.taskToolSchemaHashes] : null,
    capabilityToolContracts: declaration.capabilities && isCapabilitySuite(baseline.manifest.suite)
      ? [contracts.baseline.fields.taskToolManifests, contracts.candidate.fields.taskToolManifests] : null
  }), { margin: protocol.spec.acceptance.nonInferiorityMargin, acceptance: protocol.spec.acceptance });
  return { ...comparison, protocolKind: 'ablation', protocolHash: protocol.recordHash,
    declaredDifferences: declaration,
    actualDifferences: Object.fromEntries(allowedFields.map(key => [key,
      { baseline: baseline.manifest[key] ?? null, candidate: candidate.manifest[key] ?? null }])),
    ...(isCapabilitySuite(baseline.manifest.suite) ? { taskToolSchemaHashes: {
      baseline: contracts.baseline.taskToolSchemaHashes, candidate: contracts.candidate.taskToolSchemaHashes } }
      : { toolSchemaHashes: { baseline: contracts.baseline.toolSchemaHash, candidate: contracts.candidate.toolSchemaHash } }),
    acceptance: assessAcceptance(protocol.spec.acceptance, baseline, candidate, comparison), releaseEligible: false };
}
