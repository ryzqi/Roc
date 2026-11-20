import { spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { build } from 'esbuild';
import Database from 'better-sqlite3';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';
import { ROOT, contained, fail, fileInventory, hash, sha256, writeJson } from './common.mjs';
import { applicationManifest } from './application-manifest.mjs';
import { bindCapabilityMcpManifest, verifyCapabilityMcpEvidence } from './capability-mcp-verifier.mjs';
import { applicationContextWindow, applicationContract, applicationSessionContract, applicationTurns, verifyApplicationEvidence } from './application-verifier.mjs';
import { verifyRagApplication } from '../adapters/rag/verification.mjs';
import { hostExecutionEvidence } from './science.mjs';
import { durableJson, inspectTrialSeal, sealTrial, assertProcessGone } from './lifecycle.mjs';

export async function prepareApplication(directory, { kind: selectedKind, toolNames, taskTools } = {}) {
  const path = join(directory, 'application-worker.mjs');
  const compiled = await build({ entryPoints: [join(ROOT, 'evaluation/runtime/application-worker.ts')],
    outfile: path, bundle: true, packages: 'external', platform: 'node', format: 'esm', metafile: true,
    absWorkingDir: ROOT, loader: { '.md': 'text' }, logLevel: 'silent' });
  if (Object.keys(compiled.metafile.inputs).some(name => /fixtures|evaluation\/(?:lib|adapters|graders|analysis|tests|tasks|datasets)\//u.test(name))) fail('policy', 'evaluator_in_worker_graph');
  const packages = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const { benchmarkManifest } = await importTypeScriptModule(join(ROOT, 'evaluation/runtime/benchmark-runtime.ts'), {
    platform: 'node', external: [...Object.keys(packages.dependencies), ...Object.keys(packages.devDependencies)], tempDir: join(ROOT, 'evaluation/.runtime/imports') });
  const frozenManifest = (...args) => bindCapabilityMcpManifest(benchmarkManifest(...args));
  if (taskTools && (!selectedKind || !Array.isArray(taskTools) || !taskTools.length
    || new Set(taskTools.map(task => task.taskId)).size !== taskTools.length)) fail('data', 'application_task_tools_invalid');
  const taskManifests = taskTools?.map(task => ({ taskId: task.taskId, toolNames: [...task.toolNames].sort(),
    ...(task.runMode === undefined ? {} : { runMode: task.runMode }),
    ...(task.mcp === undefined ? {} : { mcp: task.mcp }),
    manifest: frozenManifest(selectedKind, [...task.toolNames].sort(), task.runMode, task.mcp) }));
  const artifact = { path, sha256: sha256(readFileSync(path)), manifests: Object.fromEntries(['qasper', 'scienceagentbench', 'rag-paper-qa'].map(kind =>
    [kind, frozenManifest(kind, kind === selectedKind ? toolNames : undefined)])),
    ...(taskManifests ? { taskManifests } : {}),
    nodeModulesPath: realpathSync(join(ROOT, 'node_modules')) };
  artifact.graph = { schemaVersion: 1, workerSha256: artifact.sha256, inputs: Object.keys(compiled.metafile.inputs).sort() };
  if (taskManifests) {
    const mcpContracts = new Map(taskManifests.filter(task => task.mcp !== undefined).map(task => [hash(task.mcp), task.mcp]));
    if (mcpContracts.size > 1) fail('data', 'application_union_mcp_contract_mismatch');
    const unionMode = taskManifests.some(task => task.runMode === 'task') ? 'task'
      : taskManifests.some(task => task.runMode === 'chat') ? 'chat' : undefined;
    artifact.manifests[selectedKind] = frozenManifest(selectedKind,
      [...new Set(taskManifests.flatMap(task => task.toolNames))].sort(), unionMode, [...mcpContracts.values()][0]);
  }
  writeJson(join(directory, 'worker.json'), artifact);
  return artifact;
}

export async function executeApplication({ artifact, input, directory, config, complete, record, signal, execute, stage, research,
  lifecycle = () => {}, correlation = {}, protectedPaths = [join(dirname(artifact.path), 'worker.json')] }) {
  if (process.platform !== 'darwin') fail('environment', 'macos_sandbox_required');
  if (sha256(readFileSync(artifact.path)) !== artifact.sha256) fail('state', 'worker_changed');
  const hostInput = JSON.parse(JSON.stringify(input));
  const manifest = applicationManifest(artifact, input);
  const turns = applicationTurns(input);
  const contextWindowTokens = applicationContextWindow(input, config);
  const supportsResearch = manifest.tools.some(tool => tool.modelVisibleName.startsWith('research_'));
  const supportsExecution = manifest.tools.some(tool => tool.modelVisibleName === 'run_shell_command');
  const observations = [];
  const phases = [];
  let activePhase = null;
  const executionProposals = new Map(), consumedExecutions = new Set(), consumedGrants = new Set();
  const root = join(directory, 'worker'), workspace = join(root, 'workspace');
  mkdirSync(root, { mode: 0o700 }); mkdirSync(workspace, { mode: 0o700 });
  for (const [name, bytes] of Object.entries(input.files)) {
    const target = contained(workspace, name);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
  }
  await stage?.(workspace);
  writeJson(join(directory, 'initial-workspace.json'), { schemaVersion: 1, files: fileInventory(workspace) });
  if (artifact.taskManifests) writeJson(join(directory, 'worker-graph.json'), artifact.graph);
  copyFileSync(artifact.path, join(root, 'application-worker.mjs'));
  symlinkSync(artifact.nodeModulesPath, join(root, 'node_modules'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  const node = realpathSync(process.execPath), quote = value => JSON.stringify(realpathSync(value));
  const policy = `(version 1)(deny default)(import "system.sb")
    (allow process-fork)(allow process-exec (literal ${quote(node)}))
    (allow sysctl-read file-read-metadata)
    (deny syscall-unix (syscall-number SYS_setsid) (syscall-number SYS_setpgid))
    (allow file-read* file-map-executable (subpath "/usr/lib") (subpath "/usr/share") (subpath "/System/Library")
      (subpath "/opt/homebrew/opt") (subpath "/opt/homebrew/Cellar") (subpath ${quote(artifact.nodeModulesPath)}))
    (allow file-read* file-write* file-map-executable (subpath ${quote(root)}))
    ${['qasper', 'rag-paper-qa'].includes(input.kind) || input.readOnly ? `(deny file-write* (subpath ${quote(workspace)}))` : ''}
    (allow file-read* file-write-data (literal "/dev/null") (literal "/dev/urandom"))
    (allow signal (target self))`;
  writeFileSync(join(directory, 'sandbox.sb'), policy, { mode: 0o600 });
  lifecycle('dispatched');
  const child = spawn('/usr/bin/sandbox-exec', ['-p', policy, node, join(root, 'application-worker.mjs')], {
    cwd: root, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root, LANG: 'en_US.UTF-8', OPENSSL_CONF: '/dev/null',
      LANGSMITH_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false' }
  });
  record({ type: 'worker_started', pid: child.pid });
  const { terminateProcessTreeWithRetry } = await importTypeScriptModule(join(ROOT, 'src/main/services/process-tree.ts'), { platform: 'node' });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, exitSignal) => {
    writeJson(join(directory, 'process.json'), { pid: child.pid, code, signal: exitSignal }); resolve(code);
  }); });
  void closed.catch(() => {});
  let cleanup;
  const stop = () => { cleanup ??= terminateProcessTreeWithRetry(child); void cleanup.catch(() => {}); return cleanup; };
  const controller = new AbortController();
  const taskSignal = AbortSignal.any([signal, controller.signal]);
  const abort = () => { void stop(); };
  taskSignal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('task_deadline')), config.taskTimeoutMs);
  let bytes = 0, requests = 0, result = null, truncated = false, isolationVerified = false, toolSchemaHash = null;
  function retain(name, text) {
    bytes += Buffer.byteLength(text);
    if (bytes > 32 * 1024 * 1024) { truncated = true; controller.abort(new Error('evidence_limit')); return; }
    appendFileSync(join(directory, name), text, { mode: 0o600 });
  }
  child.stderr.on('data', chunk => retain('stderr.log', chunk));
  child.stdin.on('error', () => controller.abort(new Error('worker_stdin_closed')));
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  async function snapshotDatabase(name, target) {
    const connection = new Database(join(root, name), { readonly: true, fileMustExist: true });
    try { await connection.backup(target); } finally { connection.close(); }
  }
  function pendingModelCall() {
    let connection;
    try {
      connection = new Database(join(root, 'agent.sqlite'), { readonly: true, fileMustExist: true });
      const pending = connection.prepare("SELECT * FROM agent_calls WHERE kind='model' AND state='reserved' ORDER BY rowid").all();
      if (pending.length !== 1 || activePhase && pending[0].run_id !== activePhase.runId) fail('state', 'worker_pending_model_call_invalid');
      const call = pending[0], envelope = JSON.parse(call.envelope_json);
      if (!['agent', 'summary'].includes(envelope.purpose) || !Array.isArray(envelope.messages)
        || call.input_hash !== hash({ purpose: envelope.purpose, messages: envelope.messages })
        || envelope.callId !== call.call_id) fail('state', 'worker_model_purpose_binding_invalid');
      return { purpose: envelope.purpose, modelCallId: call.call_id };
    } catch (error) {
      if (error.failureClass) throw error;
      fail('state', 'worker_model_evidence_invalid');
    } finally { connection?.close(); }
  }
  function phaseBinding(message) {
    if (!turns) return {};
    if (!activePhase || message.schemaVersion !== 2 || message.phaseId !== activePhase.id
      || message.phaseIndex !== activePhase.index) fail('state', 'worker_phase_binding_invalid');
    if (message.runId !== undefined) {
      if (typeof message.runId !== 'string' || !message.runId
        || activePhase.runId && activePhase.runId !== message.runId) fail('state', 'worker_phase_run_invalid');
      activePhase.runId = message.runId;
    }
    if (message.threadId !== undefined) {
      if (typeof message.threadId !== 'string' || !message.threadId
        || activePhase.threadId && activePhase.threadId !== message.threadId) fail('state', 'worker_phase_thread_invalid');
      activePhase.threadId = message.threadId;
    }
    return { schemaVersion: 2, phaseId: activePhase.id, phaseIndex: activePhase.index,
      runId: activePhase.runId, threadId: activePhase.threadId };
  }
  const lines = createInterface({ input: child.stdout });
  // Detect a huge unterminated line before readline can allocate an unbounded transcript.
  let stdoutBytes = 0;
  child.stdout.on('data', chunk => { stdoutBytes += chunk.length; if (stdoutBytes > 32 * 1024 * 1024) { truncated = true; controller.abort(); } });
  try {
    taskSignal.throwIfAborted();
    send({ view: { id: input.taskId ?? 'benchmark-task', family: input.viewFamily ?? (supportsExecution ? 'experiment-script' : 'literature-verification'),
      difficulty: input.difficulty ?? 'hard', prompt: input.prompt, outputFormat: 'json',
      ...(input.responseContract === undefined ? {} : { responseContract: input.responseContract }) },
      benchmark: input.kind, providerId: config.providerId ?? 'evaluation-host', modelId: config.model, temperature: config.temperature,
      benchmarkToolNames: manifest.tools.map(tool => tool.modelVisibleName),
      ...(input.runMode === undefined ? {} : { benchmarkRunMode: input.runMode }),
      ...(input.mcp === undefined ? {} : { mcp: input.mcp }),
      ...(artifact.taskManifests ? { captureInitialState: true } : {}),
      ...(turns ? { session: input.session } : {}),
      contextWindowTokens, maxOutputTokens: config.maxOutputTokens ?? 4096,
      ...(supportsResearch ? { researchProjectId: research?.projectId } : {}),
      isolationProbePaths: protectedPaths, isolationProbePort: null });
    for await (const line of lines) {
      retain('transcript.jsonl', line + '\n');
      taskSignal.throwIfAborted();
      const message = JSON.parse(line);
      if (message.type === 'runtime_ready') {
        if (!artifact.taskManifests || message.schemaVersion !== 1 || message.manifestHash !== manifest.manifestHash
          || requests !== 0 || activePhase || phases.length !== 0) fail('state', 'worker_initial_state_invalid');
        await snapshotDatabase('agent.sqlite', join(directory, 'initial-agent.sqlite'));
        await snapshotDatabase('memory.sqlite', join(directory, 'initial-memory.sqlite'));
        send({ type: 'runtime_retained' });
      } else if (message.type === 'phase_begin') {
        const turn = turns?.[phases.length];
        if (!turn || activePhase || message.schemaVersion !== 2 || message.phaseId !== turn.id
          || message.phaseIndex !== phases.length || message.thread !== turn.thread
          || message.inputHash !== hash(turn) || message.requestStart !== requests) fail('state', 'worker_phase_begin_invalid');
        const phaseDirectory = join(directory, 'phases', turn.id);
        mkdirSync(phaseDirectory, { recursive: true, mode: 0o700 });
        await snapshotDatabase('agent.sqlite', join(phaseDirectory, 'initial-agent.sqlite'));
        await snapshotDatabase('memory.sqlite', join(phaseDirectory, 'initial-memory.sqlite'));
        writeJson(join(phaseDirectory, 'initial-workspace.json'), { schemaVersion: 1, files: fileInventory(workspace) });
        activePhase = { id: turn.id, index: phases.length, thread: turn.thread, inputHash: hash(turn), requestStart: requests };
        send({ type: 'phase_ready', phaseId: turn.id });
      } else if (message.type === 'phase_end') {
        phaseBinding(message);
        if (!activePhase?.runId || !activePhase.threadId || typeof message.output !== 'string'
          || !message.checkpointId || message.requestStart !== activePhase.requestStart || message.requestEnd !== requests
          || message.manifestHash !== manifest.manifestHash || message.requestEnd <= message.requestStart
          || Buffer.byteLength(message.output) > 65536) fail('state', 'worker_phase_end_invalid');
        const phaseDirectory = join(directory, 'phases', activePhase.id);
        await snapshotDatabase('agent.sqlite', join(phaseDirectory, 'agent.sqlite'));
        await snapshotDatabase('memory.sqlite', join(phaseDirectory, 'memory.sqlite'));
        const phaseFiles = fileInventory(workspace);
        const retainedWorkspace = join(phaseDirectory, 'workspace');
        mkdirSync(retainedWorkspace, { mode: 0o700 });
        for (const file of phaseFiles) {
          const target = contained(retainedWorkspace, file.path);
          mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
          copyFileSync(contained(workspace, file.path), target);
        }
        writeJson(join(phaseDirectory, 'final-workspace.json'), { schemaVersion: 1, files: phaseFiles });
        const retained = { schemaVersion: 2, ...activePhase, requestEnd: requests, checkpointId: message.checkpointId,
          outputHash: sha256(message.output),
          artifactHashes: Object.fromEntries(fileInventory(phaseDirectory).map(file => [file.path, file.sha256])) };
        writeJson(join(phaseDirectory, 'phase.json'), retained);
        phases.push(retained); activePhase = null;
        send({ type: 'phase_retained', phaseId: retained.id });
      } else if (message.type === 'request') {
        const phase = phaseBinding(message);
        requests++;
        if (result !== null || message.index !== requests - 1 || message.requestHash !== hash(message.body)) fail('policy', 'worker_request_invalid');
        const tools = message.body.tools ?? [];
        // Admit the frozen main schema or the production summary schema before
        // consulting runtime evidence. Admission never replaces the raw ledger.
        const expected = manifest.tools.filter(t => t.executionScopes.includes('main')).map(t => t.modelVisibleName).sort();
        const validTools = Array.isArray(tools) && tools.every(t => t?.type === 'function' && typeof t.function?.name === 'string'
          && t.function.parameters && typeof t.function.parameters === 'object' && !Array.isArray(t.function.parameters));
        const summaryPrompt = message.body.messages?.[0]?.role === 'system'
          && message.body.messages[0].content === 'Summarize Roc runtime context.';
        const validSummaryTools = validTools && summaryPrompt && (tools.length === 1 && tools[0].function.name === 'roc_context_summary'
          || tools.length === 0 && message.body.response_format?.type === 'json_schema'
            && message.body.response_format.json_schema?.name === 'roc_context_summary');
        const validMainTools = validTools && hash(tools.map(t => t.function.name).sort()) === hash(expected);
        if (!validMainTools && !validSummaryTools) fail('harness', summaryPrompt ? 'worker_summary_schema_invalid' : 'worker_tool_manifest_mismatch');
        const modelBinding = pendingModelCall();
        if (modelBinding.purpose === 'summary') {
          if (!validSummaryTools) fail('harness', 'worker_summary_schema_invalid');
        } else {
          if (!validMainTools) fail('harness', 'worker_tool_manifest_mismatch');
          const observed = hash(tools);
          if (toolSchemaHash !== null && toolSchemaHash !== observed) fail('harness', 'worker_tool_schema_changed');
          if (toolSchemaHash === null) {
            toolSchemaHash = observed;
            writeJson(join(directory, 'tool-schema.json'), { schemaVersion: 1, toolSchemaHash, tools });
          }
        }
        const requestId = `chat-${correlation.traceId ?? hash(directory).slice(0, 32)}-${requests}`;
        const binding = { ...correlation, ...phase, ...modelBinding, requestId, requestHash: message.requestHash, request: requests };
        record({ type: 'model_request', ...binding, toolSchemaHash });
        const body = await complete(message.body, taskSignal, binding);
        for (const tool of modelBinding.purpose === 'agent' ? body.choices?.[0]?.message?.tool_calls ?? [] : []) {
          if (tool.function?.name !== 'run_shell_command') continue;
          if (typeof tool.id !== 'string' || !tool.id || executionProposals.has(tool.id)) fail('policy', 'worker_execution_proposal_invalid');
          let args;
          try { args = JSON.parse(tool.function.arguments); } catch { continue; }
          executionProposals.set(tool.id, args);
        }
        retain('responses.jsonl', JSON.stringify({ ...binding, responseHash: hash(body), body }) + '\n');
        taskSignal.throwIfAborted(); send({ type: 'response', body });
      } else if (message.type === 'research') {
        phaseBinding(message);
        if (!supportsResearch || !research || typeof message.toolCallId !== 'string') fail('policy', 'worker_research_denied');
        const value = await research.invoke(message.name, message.request, message.toolCallId, taskSignal);
        send({ type: 'research_result', toolCallId: message.toolCallId, result: value });
      } else if (message.type === 'execute') {
        const phase = phaseBinding(message);
        if (!supportsExecution || message.command !== 'python solution.py' || !execute) fail('policy', 'worker_execution_denied');
        if (typeof message.toolCallId !== 'string' || !message.toolCallId
          || typeof message.grantId !== 'string' || !message.grantId
          || executionProposals.get(message.toolCallId)?.command !== 'python solution.py'
          || consumedExecutions.has(message.toolCallId) || consumedGrants.has(message.grantId)) fail('policy', 'worker_execution_binding_invalid');
        if (!Number.isInteger(message.maxDurationMs) || message.maxDurationMs <= 0 || message.maxDurationMs > 120000
          || !Number.isInteger(message.maxOutputBytes) || message.maxOutputBytes <= 0 || message.maxOutputBytes > 1048576) fail('policy', 'worker_execution_limits_invalid');
        consumedExecutions.add(message.toolCallId); consumedGrants.add(message.grantId);
        record({ type: 'execution_requested', grantId: message.grantId, toolCallId: message.toolCallId });
        const beforeWorkspace = { schemaVersion: 1, files: fileInventory(workspace) };
        const executionResult = await execute(workspace, taskSignal, { timeoutMs: message.maxDurationMs, maxBytes: message.maxOutputBytes });
        const evidenceDirectory = executionResult[hostExecutionEvidence]?.directory;
        if (!evidenceDirectory || contained(directory, relative(directory, evidenceDirectory)) !== evidenceDirectory) fail('infrastructure', 'execution_host_evidence_missing');
        const afterWorkspace = { schemaVersion: 1, files: fileInventory(workspace) };
        retain('executions.jsonl', JSON.stringify(executionResult) + '\n');
        observations.push({ ...phase, schemaVersion: 1, kind: 'execution', command: message.command, grantId: message.grantId,
          toolCallId: message.toolCallId, entrypoint: 'solution.py',
          entrypointSha256: beforeWorkspace.files.find(file => file.path === 'solution.py')?.sha256 ?? null,
          beforeWorkspace, afterWorkspace, processArtifact: relative(directory, join(evidenceDirectory, 'process.json')),
          sandboxArtifact: relative(directory, join(evidenceDirectory, 'sandbox.sb')), resultHash: hash(executionResult) });
        send({ type: 'executed', result: executionResult });
      } else if (message.type === 'result') {
        if (result !== null || message.manifestHash !== manifest.manifestHash || typeof message.output !== 'string') fail('state', 'worker_result_invalid');
        if (Buffer.byteLength(message.output) > 65536) fail('agent', 'output_too_large');
        if (turns && (activePhase || phases.length !== turns.length || message.schemaVersion !== 2
          || message.phaseId !== phases.at(-1).id || !Array.isArray(message.phases)
          || message.phases.length !== phases.length)) fail('state', 'worker_phase_result_incomplete');
        result = message;
      } else if (message.type === 'isolation') {
        if (message.filesDenied !== true || message.childDenied !== true) fail('policy', 'worker_isolation_failed');
        isolationVerified = true;
      } else if (message.type === 'event') {
        phaseBinding(message);
      } else fail('infrastructure', 'worker_protocol_invalid');
    }
    const code = await closed;
    if (truncated) fail('infrastructure', 'evidence_limit');
    if (signal.aborted) fail('operator', 'run_cancelled');
    if (taskSignal.aborted) fail(controller.signal.reason?.message === 'task_deadline' ? 'agent' : 'infrastructure', controller.signal.reason?.message ?? 'worker_aborted');
    if (code !== 0 || !result || !isolationVerified) fail('harness', 'application_worker_failed');
    writeJson(join(directory, 'output.json'), result);
    lifecycle('completed');
  } catch (error) {
    if (truncated) fail('infrastructure', 'evidence_limit');
    if (signal.aborted) fail('operator', 'run_cancelled');
    if (taskSignal.aborted && !error.failureClass) fail(controller.signal.reason?.message === 'task_deadline' ? 'agent' : 'infrastructure', controller.signal.reason?.message ?? 'worker_aborted');
    throw error;
  } finally {
    clearTimeout(timer); taskSignal.removeEventListener('abort', abort); lines.close(); child.stdin.end();
    try {
      try { await stop(); unlinkSync(join(root, 'node_modules')); writeJson(join(directory, 'cleanup.json'), { processGroupGone: true, dependencyLinkRemoved: true }); }
      catch { writeJson(join(directory, 'cleanup.json'), { processGroupGone: false }); fail('infrastructure', 'worker_cleanup_unconfirmed'); }
    } finally { await research?.close(); }
  }
  writeJson(join(directory, 'final-workspace.json'), { schemaVersion: 1, files: fileInventory(workspace) });
  if (turns) writeJson(join(directory, 'phase-evidence.json'), { schemaVersion: 2, complete: true, phases });
  const verification = verifyApplicationEvidence({ artifact, input: { ...input, researchProjectId: research?.projectId },
    directory, config, requests, toolSchemaHash });
  const { finalAnswer, ...evidence } = verification;
  writeJson(join(directory, 'runtime-verification.json'), evidence);
  if (verification.status !== 'verified') fail('harness', `application_evidence_invalid:${verification.reason}`);
  writeJson(join(directory, 'final-answer.json'), finalAnswer);
  let rag;
  if (supportsResearch) {
    rag = verifyRagApplication({ directory, research });
    writeJson(join(directory, 'rag-verification.json'), rag.report);
    if (rag.report.status !== 'verified') fail('harness', `rag_evidence_invalid:${rag.report.reason}`);
  }
  let mcp;
  if (input.mcp !== undefined) {
    mcp = verifyCapabilityMcpEvidence({ directory, input, manifest });
    writeJson(join(directory, 'mcp-verification.json'), mcp);
    if (mcp.status !== 'valid') fail('harness', `mcp_evidence_invalid:${mcp.reason ?? mcp.error}`);
  }
  const verifiedResult = { output: finalAnswer.output, workspace, requests, toolSchemaHash, evidenceComplete: true,
    ...(rag ? { ragEvidence: rag.evidence, ragVerification: { status: 'verified', contractHash: rag.report.contract.hash,
      evidenceHash: sha256(readFileSync(join(directory, 'rag-verification.json'))) } } : {}),
    ...(mcp ? { mcpVerification: { status: 'valid', evidenceHash: sha256(readFileSync(join(directory, 'mcp-verification.json'))) } } : {}),
    runtimeVerification: { status: 'verified', contractHash: hash(verification.contract),
      ...(turns ? { coreContractHash: hash(applicationContract), sessionContractHash: hash(applicationSessionContract) } : {}),
      finalAnswerHash: finalAnswer.sha256, evidenceHash: sha256(readFileSync(join(directory, 'runtime-verification.json'))) } };
  const { output: _output, workspace: _workspace, ragEvidence: _ragEvidence, ...metadata } = verifiedResult;
  durableJson(join(directory, 'application-result.json'), metadata);
  if (artifact.taskManifests) writeJson(join(directory, 'protocol-observations.json'), {
    schemaVersion: turns ? 2 : 1, runId: verification.runId, threadId: verification.threadId, complete: true,
    hostInput, inputHash: hash(hostInput),
    hostManifest: manifest, hostManifestHash: hash(manifest),
    hostRuntimeConfig: { providerId: config.providerId ?? 'evaluation-host', model: config.model,
      contextWindowTokens: config.contextWindowTokens ?? 65536, maxOutputTokens: config.maxOutputTokens ?? 4096 },
    ...(turns ? { phases } : {}),
    artifactHashes: Object.fromEntries(fileInventory(directory).map(file => [file.path, file.sha256])),
    observations: observations.map(observation => observation.phaseId ? observation
      : ({ ...observation, runId: verification.runId, threadId: verification.threadId }))
  });
  lifecycle('verified', { evidenceSealHash: sealTrial(directory, 'verified-evidence.json') });
  return verifiedResult;
}

// Recovery validates existing bytes and persisted effects. It never launches a
// worker, calls a provider, reruns a tool, or reconstructs an answer from narration.
export function recoverApplication({ artifact, input, directory, config, research }) {
  assertProcessGone(directory);
  const metadata = JSON.parse(readFileSync(join(directory, 'application-result.json'), 'utf8'));
  inspectTrialSeal(directory, 'verified-evidence.json');
  const verified = verifyApplicationEvidence({ artifact, input: { ...input, researchProjectId: research?.projectId },
    directory, config, requests: metadata.requests, toolSchemaHash: metadata.toolSchemaHash });
  if (verified.status !== 'verified'
    || hash(verified.contract) !== metadata.runtimeVerification?.contractHash
    || verified.finalAnswer.sha256 !== metadata.runtimeVerification.finalAnswerHash
    || sha256(readFileSync(join(directory, 'runtime-verification.json'))) !== metadata.runtimeVerification.evidenceHash) fail('state', 'resume_application_evidence_invalid');
  let rag;
  if (applicationManifest(artifact, input).tools.some(tool => tool.modelVisibleName.startsWith('research_'))) {
    rag = verifyRagApplication({ directory, research });
    if (rag.report.status !== 'verified' || rag.report.contract.hash !== metadata.ragVerification?.contractHash
      || sha256(readFileSync(join(directory, 'rag-verification.json'))) !== metadata.ragVerification.evidenceHash) fail('state', 'resume_rag_evidence_invalid');
  }
  if (input.mcp !== undefined) {
    const mcp = verifyCapabilityMcpEvidence({ directory, input, manifest: applicationManifest(artifact, input) });
    if (mcp.status !== 'valid' || metadata.mcpVerification?.status !== 'valid'
      || sha256(readFileSync(join(directory, 'mcp-verification.json'))) !== metadata.mcpVerification.evidenceHash) {
      fail('state', 'resume_mcp_evidence_invalid');
    }
  }
  return { ...metadata, output: verified.finalAnswer.output, workspace: join(directory, 'worker/workspace'),
    ...(rag ? { ragEvidence: rag.evidence } : {}) };
}
