export type ModelOutputCompletion = 'complete' | 'truncated' | 'unknown';

/** Provider metadata describes completion; parseable JSON alone cannot prove it. */
export function readModelOutputCompletion(
  metadata: Record<string, unknown>, additionalKwargs: Record<string, unknown> = {}
): ModelOutputCompletion {
  // Anthropic's invoke/legacy chunk stream keeps stop_reason in additional_kwargs;
  // its native event stream normalizes max_tokens to finish_reason=length.
  const sources = [metadata, additionalKwargs];
  if (sources.some(source => source.finish_reason === 'length' || source.stop_reason === 'max_tokens' ||
    source.status === 'incomplete')) return 'truncated';
  if (sources.some(source => ['stop', 'tool_calls', 'tool_use'].includes(String(source.finish_reason)) ||
    ['end_turn', 'stop_sequence', 'tool_use'].includes(String(source.stop_reason)) ||
    source.status === 'completed')) return 'complete';
  // Compatible providers may omit these fields. Preserve compatibility without claiming completeness.
  return 'unknown';
}
