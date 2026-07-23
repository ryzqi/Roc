import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

import type { ContextArtifactStore } from './context-artifact-store';

const DEFAULT_CONTEXT_ARTIFACT_SLICE_CHARS = 4_000;
const MAX_CONTEXT_ARTIFACT_SLICE_CHARS = 12_000;

const contextArtifactReadSchema = z.object({
  artifactId: z.string().trim().min(1),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/u),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(MAX_CONTEXT_ARTIFACT_SLICE_CHARS).optional()
});

type ContextArtifactReadToolInput = z.infer<typeof contextArtifactReadSchema>;

export function createContextArtifactReadTool(input: {
  artifactStore: ContextArtifactStore;
  threadId: string;
  workspaceHash: string | null;
}): DynamicStructuredTool<
  typeof contextArtifactReadSchema,
  ContextArtifactReadToolInput,
  ContextArtifactReadToolInput,
  string
> {
  return new DynamicStructuredTool<
    typeof contextArtifactReadSchema,
    ContextArtifactReadToolInput,
    ContextArtifactReadToolInput,
    string
  >({
    name: 'read_context_artifact',
    description:
      'Read one bounded slice of a Roc context artifact from the current thread and workspace. Requires the artifactId and sha256 from the artifact reference.',
    schema: contextArtifactReadSchema,
    func: async (request) => {
      const artifact = input.artifactStore.readArtifact({
        artifactId: request.artifactId,
        expectedSha256: request.sha256.toLowerCase(),
        threadId: input.threadId,
        workspaceHash: input.workspaceHash
      });
      if (artifact === null) {
        throw new Error('context_artifact_not_found_or_scope_mismatch');
      }

      const offset = request.offset === undefined ? 0 : request.offset;
      if (offset > artifact.content.length) {
        throw new Error('context_artifact_offset_out_of_range');
      }
      const limit = request.limit === undefined ? DEFAULT_CONTEXT_ARTIFACT_SLICE_CHARS : request.limit;
      const end = Math.min(artifact.content.length, offset + limit);
      const complete = end >= artifact.content.length;
      return JSON.stringify({
        artifactId: artifact.artifactId,
        sha256: artifact.sha256,
        kind: artifact.kind,
        originalChars: artifact.originalChars,
        offset,
        content: artifact.content.slice(offset, end),
        nextOffset: complete ? null : end,
        complete
      });
    }
  });
}
