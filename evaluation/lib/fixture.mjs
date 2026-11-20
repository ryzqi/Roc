// Wiring check only. This transport receives no dataset references or evaluator state.
export const fixtureConfig = { model: 'roc-fixture', temperature: 0, taskTimeoutMs: 30000 };
export function fixtureCompletion(body) {
  const hasRead = body.messages.some(m => m.role === 'tool');
  const message = hasRead ? { role: 'assistant', content: '{"answer":"Unanswerable","evidence":[]}' }
    : { role: 'assistant', content: null, tool_calls: [{ id: 'fixture-read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ file_path: '/workspace/paper.json', offset: 0, limit: 20 }) } }] };
  return { id: `fixture-response-${body.messages.length}`, object: 'chat.completion', created: 0, model: body.model,
    choices: [{ index: 0, finish_reason: hasRead ? 'stop' : 'tool_calls', message }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };
}
