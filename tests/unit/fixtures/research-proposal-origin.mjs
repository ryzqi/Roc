/** Seed the same active chat and durable effect that authorize a real proposal tool call. */
export function proposalChat(api, fixture) {
  const runId = 'proposal-chat-run', threadId = 'proposal-chat-thread';
  const projectId = fixture.project.id, startedAt = '2026-11-21T00:00:00.000Z';
  const manifest = api.compileRunCapabilityManifest({deleteFileApprovalMode: 'fully_automatic', mcpApprovalMode: 'fully_automatic',
    mcpServers: [], mode: 'chat', requestedCapabilities: {mcpServers: [], skills: []}, selfConfigAvailable: false,
    shellAllowedCommands: undefined, trustedHostAvailable: false, skills: [], workflowHint: null, researchProjectId: projectId}).manifest;
  const {canonicalIdentity, modelVisibleName: toolName, toolVersion, effectClass} =
    manifest.tools.find(tool => tool.modelVisibleName === 'research_propose_change');
  const snapshot = api.createRunExecutionSnapshot({runId, threadId, inputMessageId: 'proposal-message', snapshot: {
    schemaVersion: 11, submissionHash: 'a'.repeat(64),
    taskContract: {contractVersion: 1, objective: 'Prepare a method proposal', constraints: [], kind: 'reply',
      criteria: [{id: 'proposal', description: 'A reviewable method proposal', check: {kind: 'response'}}]},
    runOrigin: 'chat', model: {providerId: 'fixture', modelId: 'fixture'}, mode: 'run', workspace: null,
    capabilityManifest: manifest, workflowHint: null, explicitSkillIds: [], dispatchKey: null,
    researchProjectId: projectId, modelConfig: api.createRunModelConfig({contextWindowTokens: null, startedAt})
  }});
  fixture.agentDb.prepare(`INSERT INTO agent_threads(id,kind,title,goal,status,research_project_id,created_at,updated_at)
    VALUES (?,'chat','Proposal','Proposal','active',?,?,?)`).run(threadId, projectId, startedAt, startedAt);
  fixture.agentDb.prepare(`INSERT INTO agent_runs
    (id,thread_id,run_number,user_input,status,started_at,enabled_capabilities_json,run_origin,snapshot_json,snapshot_version)
    VALUES (?,?,1,'Proposal','running',?,'{}','chat',?,11)`).run(runId, threadId, startedAt, JSON.stringify(snapshot));
  const effects = new api.AgentToolEffectStore(fixture.agentDb), receipts = [];
  let sequence = 0;
  return {runId, threadId, manifest, snapshot, receipts, operation(args) {
    const started = effects.beginOperation({runId, threadId, executionPath: 'main', checkpointId: 'checkpoint',
      toolCallId: `proposal-call-${++sequence}`, toolName, canonicalToolIdentity: canonicalIdentity,
      toolVersion, args, effectClass, reconcileStrategy: 'retry_safe'});
    if (started.kind !== 'execute') throw Error('proposal_fixture_operation_not_started');
    effects.markStarted(started.lease);
    return {...api.createCapabilityOperationContext({...started.lease, recordReceipt: receipt => receipts.push(receipt)}),
      capabilityName: 'research.proposals.create', capabilityVersion: '1.0.0'};
  }};
}
