import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

import type { ContextArtifactStore } from './context-artifact-store';

const DEFAULT_CONTEXT_ARTIFACT_SLICE_CHARS = 4_000;
const MAX_CONTEXT_ARTIFACT_SLICE_CHARS = 12_000;

const contextArtifactReadSchema = z.object({
  artifactId: z.string().trim().min(1).describe('Exact artifactId from a context-artifact reference; not a file path.'),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/u).describe('Exact SHA-256 from the same reference; required to verify content integrity.'),
  offset: z.number().int().nonnegative().optional().describe('Zero-based UTF-16 character offset, not a line or byte offset. Default 0; use the previous page\'s nextOffset to continue.'),
  limit: z.number().int().positive().max(MAX_CONTEXT_ARTIFACT_SLICE_CHARS).optional()
    .describe(`Maximum UTF-16 characters to return. Default ${DEFAULT_CONTEXT_ARTIFACT_SLICE_CHARS}; maximum ${MAX_CONTEXT_ARTIFACT_SLICE_CHARS}.`)
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
      'Recover a bounded slice of retained context evidence in the current thread/workspace using artifactId and sha256 from its reference. The preview is incomplete. Start at offset 0, then pass nextOffset unchanged to continue; complete=true and nextOffset=null mark the end. Read only the pages needed for the task.',
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
        expiresAt: artifact.expiresAt,
        originalChars: artifact.originalChars,
        offset,
        content: artifact.content.slice(offset, end),
        nextOffset: complete ? null : end,
        complete
      });
    }
  });
}
