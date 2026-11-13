// Controller-only inputs and fault schedules. Never bundled into the agent worker.
const writePrompt = 'Write exactly "durable result\\n" to /workspace/result.txt using write_file, then finish.';
const writeCase = (id, fault) => ({
  id, dimension: 'tool-effects', fault, tools: ['write_file'], files: {}, prompt: writePrompt,
  expectedFiles: { 'result.txt': 'durable result\n' }, recover: true
});
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
    files: { 'keep.txt': 'unchanging result\n' }, expectedFiles: { 'keep.txt': 'unchanging result\n' } }
];

export function selectHarnessCases(profile = 'fast', task) {
  if (!['smoke', 'fast', 'full'].includes(profile)) throw new Error('harness_profile_requires_smoke_fast_or_full');
  if (task !== undefined && !harnessCases.some(c => c.id === task)) throw new Error('harness_task_not_found');
  const smoke = new Set(['tool-result-replay', 'tool-receipt-unknown', 'approval-reject']);
  return { cases: harnessCases.filter(c => task ? c.id === task : profile !== 'smoke' || smoke.has(c.id)),
    repeats: profile === 'full' ? 3 : 1 };
}

function toolCall(name, args, id) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}
export function harnessCompletion(scenario, body, index) {
  let calls = [];
  const hasToolResult = body.messages.some(m => m.role === 'tool');
  if (scenario.id.startsWith('tool-') && scenario.id !== 'tool-loop' && !hasToolResult) {
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
  }
  return { id: `harness-${index}`, object: 'chat.completion', created: 0, model: body.model,
    choices: [{ index: 0, finish_reason: calls.length ? 'tool_calls' : 'stop',
      message: calls.length ? { role: 'assistant', content: null, tool_calls: calls }
        : { role: 'assistant', content: 'Harness task complete.' } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };
}
