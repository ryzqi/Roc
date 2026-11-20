// Controller-only inputs and fault schedules. Never bundled into the agent worker.
const writePrompt = 'Write exactly "durable result\\n" to /workspace/result.txt using write_file, then finish.';
const writeCase = (id, fault) => ({
  id, dimension: 'tool-effects', fault, tools: ['write_file'], files: {}, prompt: writePrompt,
  expectedFiles: { 'result.txt': 'durable result\n' }, recover: true
});
const source = 'revision-one\n';
const largeSource = Array.from({ length: 360 }, (_, i) =>
  `record-${String(i).padStart(4, '0')}: observed source bytes abcdefghijklmnopqrstuvwxyz 0123456789 repeated evidence.\n`).join('');
export const harnessCoreCaseIds = Object.freeze([
  'cold-model-resume', 'tool-before-dispatch', 'tool-result-replay', 'tool-receipt-unknown',
  'approval-reject', 'approval-approve', 'cancel-model', 'parallel-edits', 'denied-tool', 'tool-loop'
]);
export const harnessSmokeCaseIds = Object.freeze(['tool-result-replay', 'tool-receipt-unknown', 'approval-reject']);
export const harnessCases = [
  { id: 'cold-model-resume', dimension: 'recovery', fault: 'model-pending', tools: [], files: {},
    prompt: 'Finish this task with a brief completion message.', expectedFiles: {}, recover: true },
  writeCase('tool-before-dispatch', 'before-dispatch'),
  writeCase('tool-result-replay', 'result-stored'),
  writeCase('tool-receipt-unknown', 'receipt-durable'),
  ...['reject', 'approve'].map(decision => ({
    id: `approval-${decision}`, dimension: 'approval', fault: 'none', decision, tools: ['delete_file'],
    prompt: 'Delete /workspace/keep.txt using delete_file, respecting the human approval decision.',
    files: { 'keep.txt': 'keep until approved\n' },
    expectedFiles: decision === 'reject' ? { 'keep.txt': 'keep until approved\n' } : {}
  })),
  { id: 'cancel-model', dimension: 'cancellation', fault: 'none', cancel: true, tools: [], files: {},
    prompt: 'Finish this task with a brief completion message.', expectedFiles: {} },
  { id: 'parallel-edits', dimension: 'concurrency', fault: 'none', tools: ['edit_file'],
    prompt: 'Change alpha to ALPHA and beta to BETA in /workspace/shared.txt using two edit_file calls.',
    files: { 'shared.txt': 'alpha\nbeta\n' }, expectedFiles: { 'shared.txt': 'ALPHA\nBETA\n' } },
  { id: 'denied-tool', dimension: 'permissions', fault: 'none', tools: ['read_file'],
    prompt: 'Read /workspace/keep.txt. The workspace is read only; do not create files.',
    files: { 'keep.txt': 'read only\n' }, expectedFiles: { 'keep.txt': 'read only\n' } },
  { id: 'tool-loop', dimension: 'loop-control', fault: 'none', tools: ['read_file'],
    prompt: 'Read /workspace/keep.txt and finish. Repeated identical reads add no information.',
    files: { 'keep.txt': 'unchanging result\n' }, expectedFiles: { 'keep.txt': 'unchanging result\n' } },
  { id: 'approval-expired', dimension: 'approval', fault: 'approval-expired', tools: ['run_trusted_host_command'],
    prompt: 'Request approval to run "printf approved" with run_trusted_host_command. Report an expired approval as a failure.',
    files: {}, expectedFiles: {} },
  { id: 'permission-change', dimension: 'permissions', fault: 'none', tools: ['read_file', 'write_file'],
    mutation: { atRequest: 1, kind: 'revoke-write' },
    prompt: 'Read /workspace/source.txt, then write its contents to /workspace/result.txt. Report a write permission failure.',
    files: { 'source.txt': source }, expectedFiles: { 'source.txt': source } },
  { id: 'workspace-replaced', dimension: 'permissions', fault: 'none', tools: ['read_file', 'write_file'],
    mutation: { atRequest: 1, kind: 'replace-workspace' },
    prompt: 'Read /workspace/source.txt, then write its contents to /workspace/result.txt. Respect the pinned workspace identity.',
    files: { 'source.txt': source }, expectedFiles: { 'source.txt': source } },
  { id: 'concurrent-edit-conflict', dimension: 'concurrency', fault: 'none', tools: ['edit_file'],
    prompt: 'Attempt two concurrent edits of the same revision-one line to FIRST and SECOND in /workspace/source.txt. Preserve the unrelated line; report the conflicting edit.',
    files: { 'source.txt': 'revision-one\nunrelated\n' },
    expectedFiles: { 'source.txt': 'FIRST\nunrelated\n' },
    alternativeFiles: [{ 'source.txt': 'SECOND\nunrelated\n' }] },
  { id: 'source-updated', dimension: 'source-freshness', fault: 'none', tools: ['read_file', 'edit_file'],
    mutation: { atRequest: 1, kind: 'update-source', path: 'source.txt', content: 'revision-two\n' },
    prompt: 'Read /workspace/source.txt, then replace revision-one with processed-one only if that exact source is still present. Re-read after a stale-source error.',
    files: { 'source.txt': source }, expectedFiles: { 'source.txt': 'revision-two\n' } },
  { id: 'memory-db-error', dimension: 'memory-persistence', fault: 'memory-db-error', tools: ['edit_file'],
    memory: { key: '/MEMORY.md', content: 'durable memory before fault\n' },
    prompt: 'Change "before fault" to "after fault" in /memory/global/MEMORY.md. Report a persistence error without claiming a saved memory.',
    files: {}, expectedFiles: {} },
  { id: 'budget-stop', dimension: 'budget-control', fault: 'none', tools: ['read_file', 'write_file'], requestBudget: 1,
    prompt: 'Read /workspace/source.txt, then write /workspace/result.txt. Stop when the host request budget is exhausted.',
    files: { 'source.txt': source }, expectedFiles: { 'source.txt': source } },
  { id: 'subagent-cancel', dimension: 'subagents', fault: 'none', tools: ['task', 'read_file'], cancelAtRequest: 1,
    prompt: 'Delegate reading /workspace/keep.txt to a general-purpose subagent and wait for its result.',
    files: { 'keep.txt': 'child input\n' }, expectedFiles: { 'keep.txt': 'child input\n' } },
  { id: 'subagent-error', dimension: 'subagents', fault: 'none', tools: ['task', 'read_file'], modelErrorAtRequest: 1,
    prompt: 'Delegate reading /workspace/keep.txt to a general-purpose subagent. If it fails, report failure without using an unreturned result.',
    files: { 'keep.txt': 'child input\n' }, expectedFiles: { 'keep.txt': 'child input\n' } },
  { id: 'mcp-disconnect', dimension: 'mcp-transport', fault: 'mcp-disconnect', tools: ['probe'], mcp: true,
    prompt: 'Call probe once with requestId disconnect-once. Report a lost connection without claiming a remote success.',
    files: {}, expectedFiles: {} },
  { id: 'mcp-receipt-lost', dimension: 'mcp-transport', fault: 'mcp-receipt-lost', tools: ['probe'], mcp: true, recover: true,
    prompt: 'Call probe once with requestId durable-remote-once. Do not retry an external effect whose reply is missing.',
    files: {}, expectedFiles: {} },
  { id: 'context-compaction-crash', dimension: 'context-recovery', fault: 'context-compacted',
    tools: ['read_file', 'grep', 'read_context_artifact'], recover: true,
    prompt: 'Observe every record in /workspace/large.txt using grep for "observed source bytes" with max_count 2000 and output_mode content, then finish. Keep original evidence available through read_context_artifact if compacted.',
    files: { 'large.txt': largeSource }, expectedFiles: { 'large.txt': largeSource } }
];

export function selectHarnessCases(profile = 'fast', task) {
  if (!['smoke', 'fast', 'full'].includes(profile)) throw new Error('harness_profile_requires_smoke_fast_or_full');
  if (task !== undefined && !harnessCases.some(c => c.id === task)) throw new Error('harness_task_not_found');
  const smoke = new Set(harnessSmokeCaseIds);
  return { cases: harnessCases.filter(c => task ? c.id === task : profile !== 'smoke' || smoke.has(c.id)),
    repeats: profile === 'full' ? 3 : 1 };
}

function toolCall(name, args, id) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}
export function harnessCompletion(scenario, body, index) {
  let calls = [];
  const hasToolResult = body.messages.some(m => m.role === 'tool');
  if (['tool-before-dispatch', 'tool-result-replay', 'tool-receipt-unknown'].includes(scenario.id) && !hasToolResult) {
    calls = [toolCall('write_file', { file_path: '/workspace/result.txt', content: 'durable result\n' }, 'write-once')];
  } else if (scenario.decision && !hasToolResult) {
    calls = [toolCall('delete_file', { file_path: '/workspace/keep.txt' }, 'delete-reviewed')];
  } else if (scenario.id === 'parallel-edits' && !hasToolResult) {
    calls = [toolCall('edit_file', { file_path: '/workspace/shared.txt', old_string: 'alpha', new_string: 'ALPHA' }, 'edit-alpha'),
      toolCall('edit_file', { file_path: '/workspace/shared.txt', old_string: 'beta', new_string: 'BETA' }, 'edit-beta')];
  } else if (scenario.id === 'denied-tool' && !hasToolResult && index === 0) {
    calls = [toolCall('write_file', { file_path: '/workspace/forbidden.txt', content: 'unauthorized\n' }, 'write-denied')];
  } else if (scenario.id === 'tool-loop' && index < 6) {
    // A missing product loop guard terminates normally at this controller bound
    // and fails verification, instead of hanging or becoming a false invalid run.
    calls = [toolCall('read_file', { file_path: '/workspace/keep.txt' }, `repeated-read-${index}`)];
  } else if (scenario.id === 'approval-expired' && !hasToolResult) {
    calls = [toolCall('run_trusted_host_command', { command: 'printf approved' }, 'expired-command')];
  } else if (['permission-change', 'workspace-replaced', 'budget-stop', 'source-updated'].includes(scenario.id)) {
    if (!hasToolResult) calls = [toolCall('read_file', { file_path: '/workspace/source.txt' }, 'observe-source')];
    else if (index === 1) calls = [scenario.id === 'source-updated'
      ? toolCall('edit_file', { file_path: '/workspace/source.txt', old_string: 'revision-one', new_string: 'processed-one' }, 'stale-edit')
      : toolCall('write_file', { file_path: '/workspace/result.txt', content: source }, 'write-after-read')];
    else if (scenario.id === 'source-updated' && index === 2) calls = [toolCall('read_file', { file_path: '/workspace/source.txt' }, 'observe-updated-source')];
  } else if (scenario.id === 'concurrent-edit-conflict' && !hasToolResult) {
    calls = ['FIRST', 'SECOND'].map((value, i) => toolCall('edit_file',
      { file_path: '/workspace/source.txt', old_string: 'revision-one', new_string: value }, `conflicting-edit-${i}`));
  } else if (scenario.id === 'memory-db-error' && !hasToolResult) {
    calls = [toolCall('edit_file', { file_path: '/memory/global/MEMORY.md',
      old_string: 'before fault', new_string: 'after fault' }, 'memory-edit')];
  } else if (scenario.id.startsWith('subagent-') && index === 0) {
    calls = [toolCall('task', { subagent_type: 'general-purpose',
      description: 'Read /workspace/keep.txt and return only the observed contents.' }, 'delegate-once')];
  } else if (scenario.mcp && !hasToolResult) {
    calls = [toolCall('probe', { requestId: scenario.recover ? 'durable-remote-once' : 'disconnect-once' }, 'mcp-once')];
  } else if (scenario.id === 'context-compaction-crash' && !hasToolResult) {
    // deepagents 1.15 read_file emits text blocks; the production compactor
    // persists string results. Real grep returns the full observed source as
    // a string, so this reaches compaction without rewriting a tool result.
    calls = [toolCall('grep', { pattern: 'observed source bytes', path: '/workspace/large.txt',
      max_count: 2000, output_mode: 'content' }, 'read-large-source')];
  }
  const failed = ['approval-expired', 'permission-change', 'workspace-replaced', 'concurrent-edit-conflict',
    'memory-db-error', 'subagent-error', 'mcp-disconnect'].includes(scenario.id);
  return { id: `harness-${index}`, object: 'chat.completion', created: 0, model: body.model,
    choices: [{ index: 0, finish_reason: calls.length ? 'tool_calls' : 'stop',
      message: calls.length ? { role: 'assistant', content: null, tool_calls: calls }
        : { role: 'assistant', content: failed ? 'The operation failed; no unreturned result was accepted.' : 'Harness task complete.' } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };
}
