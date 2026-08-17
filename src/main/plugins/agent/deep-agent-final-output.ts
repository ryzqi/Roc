import type {
  DeepAgents110V3Output,
  DeepAgents110V3Run
} from '../../services/deep-agent/deep-agents-1-10-stream-adapter';

export function readInterrupted(run: Pick<DeepAgents110V3Run, 'interrupted'>): boolean {
  return run.interrupted;
}

export function readFinalAssistantText(output: DeepAgents110V3Output): string | null {
  return output.finalAssistantText;
}

