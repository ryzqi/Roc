import { SystemMessage } from '@langchain/core/messages';
import { createFilesystemMiddleware, createMemoryMiddleware, type FilesystemPermission, type FsToolName } from 'deepagents';
import { createMiddleware, todoListMiddleware } from 'langchain';
import type { RunCapabilityExecutionScopeV1, RunCapabilityManifestV1 } from '../../../shared/types';
import type { RocCompositeBackend } from './backend';

const FILESYSTEM_NAMES = ['ls', 'read_file', 'write_file', 'edit_file', 'delete', 'glob', 'grep', 'execute'] as const satisfies readonly FsToolName[];

export function createCapabilityTodoMiddleware(
  manifest: RunCapabilityManifestV1,
  scope: RunCapabilityExecutionScopeV1
) {
  // A same-name disabled entry also replaces todo middleware added by model profiles.
  return allowedNames(manifest, scope).has('write_todos')
    ? todoListMiddleware()
    : createMiddleware({ name: 'todoListMiddleware' });
}

export function createCapabilityFilesystemMiddleware(
  backend: RocCompositeBackend,
  permissions: FilesystemPermission[],
  manifest: RunCapabilityManifestV1,
  scope: RunCapabilityExecutionScopeV1
) {
  const allowed = allowedNames(manifest, scope);
  const tools: FsToolName[] = FILESYSTEM_NAMES.filter(name => allowed.has(name));
  // Deep Agents requires read_file in its filesystem tool set. The final
  // capability boundary still removes it from requests when it is unauthorized.
  if (!tools.includes('read_file')) tools.unshift('read_file');
  return createFilesystemMiddleware({
    backend, permissions, tools,
    // Roc owns context retention (ADR 0027). Framework eviction writes to routes
    // this backend rejects, replacing oversized tool evidence with a write error
    // before Roc can persist it. Keep the original messages for Roc compaction.
    toolTokenLimitBeforeEvict: null,
    humanMessageTokenLimitBeforeEvict: null,
    customToolDescriptions: {
      ls: 'List a directory using an explicit path under /workspace/, /memory/, or /skills/. Use it to discover an unknown path. When the task supplies an exact file path, read that file directly; listing its parent directory first is unnecessary.',
      read_file: [
        'Read a file using file_path under /workspace/, /memory/, or /skills/.',
        'Text pagination uses a zero-based line offset (default 0) and a line limit (default 100). Read the relevant range; continue with the next offset in the returned @@ header when more evidence is needed.',
        'The @@ header is metadata, not file content; exclude it from edits. For supported images, audio, video, or PDF files, provide file_path only.'
      ].join(' '),
      glob: 'Find file paths by glob pattern, such as **/*.tex. Always set path to a directory under /workspace/, /memory/, or /skills/; the default root is not accessible. Narrow path or pattern if results are truncated.',
      grep: [
        'Search file contents for a literal substring, not a regular expression; foo|bar matches those exact characters.',
        'Always set path under /workspace/, /memory/, or /skills/ and use glob to narrow files.',
        'Choose output_mode: files_with_matches for paths, content for matching lines, or count for counts per file. Use max_count to bound matches.',
        'Truncated matches or clipped lines are partial evidence. Narrow the query or read the relevant file range before claiming completeness.'
      ].join(' '),
      write_file: 'Create or replace the entire file at file_path under /workspace/ or /memory/. Before replacing an existing file, inspect its current contents and preserve unrelated work; use targeted edits for partial changes. Read back or run a focused check after writing.',
      edit_file: 'Replace exact old_string with new_string in file_path under /workspace/ or /memory/. Read the relevant current range first and preserve whitespace. Include enough context for one match; set replace_all only when all occurrences should change. On a missing or ambiguous match, re-read and correct the edit before retrying. Read back or run a focused check afterward.'
    }
  });
}

/** Refresh at the start of each invocation; checkpoint resumes keep that run's snapshot. */
export function createCapabilityMemoryMiddleware(
  backend: RocCompositeBackend,
  sources: readonly string[],
  manifest: RunCapabilityManifestV1
) {
  const framework = createMemoryMiddleware({ backend, sources: [...sources], addCacheControl: true });
  const load = framework.beforeAgent;
  if (typeof load !== 'function') throw new Error('framework_memory_loader_missing');
  const middleware: typeof framework = {
    ...framework,
    beforeAgent: ((state, runtime) => load({ ...state, memoryContents: undefined }, runtime)) satisfies typeof load
  };
  if (allowedNames(manifest, 'main').has('edit_file')) return middleware;
  const wrap = middleware.wrapModelCall;
  if (wrap === undefined) throw new Error('framework_memory_wrapper_missing');
  return {
    ...middleware,
    wrapModelCall: ((request, handler) => wrap(request, forwarded => {
      const previousCount = typeof request.systemMessage.content === 'string' ? 1 : request.systemMessage.content.length;
      const blocks = forwarded.systemMessage?.content;
      if (!Array.isArray(blocks) || blocks.length !== previousCount + 1) throw new Error('framework_memory_prompt_boundary_changed');
      const block = blocks.at(-1)!;
      const text = block.type === 'text' ? block.text : undefined;
      const boundary = typeof text === 'string' ? text.lastIndexOf('<memory_guidelines>') : -1;
      if (typeof text !== 'string' || !text.trimStart().startsWith('<agent_memory>') ||
          !text.trimEnd().endsWith('</memory_guidelines>') || boundary < 0) {
        throw new Error('framework_memory_prompt_boundary_changed');
      }
      return handler({
        ...forwarded,
        systemMessage: new SystemMessage({
          ...forwarded.systemMessage,
          content: [...blocks.slice(0, -1), {
            ...block,
            text: text.slice(0, boundary) + 'Use the injected memory as reference context for the current task. Follow current task requirements and the available tool guidance.'
          }]
        })
      });
    })) satisfies NonNullable<typeof wrap>
  };
}

function allowedNames(manifest: RunCapabilityManifestV1, scope: RunCapabilityExecutionScopeV1): Set<string> {
  return new Set(manifest.tools.filter(tool => tool.executionScopes.includes(scope)).map(tool => tool.modelVisibleName));
}
