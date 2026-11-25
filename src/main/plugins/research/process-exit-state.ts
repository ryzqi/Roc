const unproven = new Set(['research_process_kill_failed', 'research_process_supervision_failed',
  'research_process_completion_failed']);

/** A wrapping cleanup failure cannot turn an unconfirmed process exit into permission to remove its inputs. */
export function hasUnprovenResearchProcessExit(error: unknown): boolean {
  const pending: unknown[] = [error], seen = new Set<Error>();
  while (pending.length) {
    const value = pending.pop();
    if (!(value instanceof Error) || seen.has(value)) continue;
    seen.add(value);
    if ('code' in value && unproven.has(String(value.code))) return true;
    if (value.cause !== undefined) pending.push(value.cause);
    if (value instanceof AggregateError) pending.push(...value.errors);
  }
  return false;
}
