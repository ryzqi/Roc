import { ContextArtifactStore } from './context/context-artifact-store';
import { redactUnknown } from './stream-tool-utils';

const maxInlineToolOutputChars = 4_096;

export type ToolOutputProjector = (input: { callId: string; name: string; output: unknown }) => unknown;

export function createToolOutputProjector(input: {
  artifactStore: ContextArtifactStore;
  runId: string;
  threadId: string;
  workspaceHash: string | null;
}): ToolOutputProjector {
  return ({ callId, name, output }) => {
    const redacted = redactUnknown(output);
    const serialized = serializeRedactedOutput(redacted);
    if (serialized.length <= maxInlineToolOutputChars) {
      return redacted;
    }
    const artifact = input.artifactStore.persistArtifact({
      content: serialized,
      kind: 'tool_result',
      runId: input.runId,
      threadId: input.threadId,
      toolCallId: callId,
      toolName: name,
      workspaceHash: input.workspaceHash
    });
    return {
      kind: 'tool_result_artifact',
      artifactId: artifact.artifactId,
      originalChars: artifact.originalChars,
      preview: artifact.preview,
      sha256: artifact.sha256,
      truncated: true
    };
  };
}

function serializeRedactedOutput(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}
