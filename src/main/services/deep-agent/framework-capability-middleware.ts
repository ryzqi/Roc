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
  // Deep Agents requires read_file for internal large-result recovery. The final
  // capability boundary still removes it from requests when it is unauthorized.
  if (!tools.includes('read_file')) tools.unshift('read_file');
  return createFilesystemMiddleware({
    backend, permissions, tools,
    customToolDescriptions: {
      ls: 'Lists files in a directory. Use it to discover an unknown path. When the task supplies an exact file path, read that file directly; listing its parent directory first is unnecessary.'
    }
  });
}

/** Keep framework memory loading/caching, and change only its newly appended guidance block. */
export function createCapabilityMemoryMiddleware(
  backend: RocCompositeBackend,
  sources: readonly string[],
  manifest: RunCapabilityManifestV1
) {
  const middleware = createMemoryMiddleware({ backend, sources: [...sources], addCacheControl: true });
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
