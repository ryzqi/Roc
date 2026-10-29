import type { RunExecutionSnapshot } from './types';

export type AgentTaskSource = 'background_schedule' | 'workbench' | null;

export function taskSourceFromRunSnapshot(
  snapshot: Pick<RunExecutionSnapshot, 'runOrigin' | 'mode'>
): AgentTaskSource {
  if (snapshot.runOrigin === 'background_schedule') return 'background_schedule';
  if (snapshot.runOrigin === 'workbench_creation' || snapshot.mode === 'task') return 'workbench';
  return null;
}
