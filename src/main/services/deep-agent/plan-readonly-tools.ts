import { SystemMessage } from '@langchain/core/messages';
import type { FileDownloadResponse } from 'deepagents';
import { createMiddleware } from 'langchain';
import { z } from 'zod';
import type { RocCompositeBackend } from './backend';

const planMemoryStateSchema = z.object({
  roc_plan_memory_contents: z.record(z.string(), z.string()).optional()
});

export function createRocPlanReadOnlyMemoryMiddleware(input: {
  backend: RocCompositeBackend;
  memorySources: readonly string[];
}) {
  return createMiddleware({
    name: 'RocPlanReadOnlyMemoryMiddleware',
    stateSchema: planMemoryStateSchema,
    beforeAgent: async (state) => {
      if (hasPlanMemoryContents(state)) {
        return undefined;
      }
      const contents: Record<string, string> = {};
      for (const source of input.memorySources) {
        const content = await readMemorySource(input.backend, source);
        if (content !== null) {
          contents[source] = content;
        }
      }
      return {
        roc_plan_memory_contents: contents
      };
    },
    wrapModelCall: async (request, handler) => {
      const contents = readPlanMemoryContents(request.state);
      const memorySection = buildReadOnlyMemorySection(contents, input.memorySources);
      return await handler({
        ...request,
        systemMessage: appendSystemText(request.systemMessage, memorySection)
      });
    }
  });
}

function readBackendMethod<TArgs extends unknown[], TResult>(
  backend: RocCompositeBackend,
  name: string
): (...args: TArgs) => Promise<TResult> {
  const method = Reflect.get(backend, name);
  if (typeof method !== 'function') {
    throw new Error(`plan_readonly_backend_method_missing:${name}`);
  }
  return async (...args) => await method.apply(backend, args) as TResult;
}

async function readMemorySource(backend: RocCompositeBackend, source: string): Promise<string | null> {
  const downloadFiles = readBackendMethod<[string[]], FileDownloadResponse[]>(backend, 'downloadFiles');
  const results = await downloadFiles([source]);
  const first = results[0];
  if (first === undefined || first.error !== undefined || first.content === null) {
    return null;
  }
  return new TextDecoder().decode(first.content);
}

function hasPlanMemoryContents(state: unknown): boolean {
  return state !== null && typeof state === 'object' && Reflect.has(state, 'roc_plan_memory_contents');
}

function readPlanMemoryContents(state: unknown): Record<string, string> {
  if (state === null || typeof state !== 'object') {
    return {};
  }
  const contents = Reflect.get(state, 'roc_plan_memory_contents');
  if (contents === null || typeof contents !== 'object' || Array.isArray(contents)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(contents)) {
    if (typeof value === 'string') {
      result[key] = value;
    }
  }
  return result;
}

function buildReadOnlyMemorySection(contents: Record<string, string>, sources: readonly string[]): string {
  const sections = sources.flatMap((source) => {
    const content = contents[source];
    if (content === undefined) {
      return [];
    }
    return [`${source}\n${content}`];
  });
  return [
    '<agent_memory>',
    sections.length === 0 ? '(No memory loaded)' : sections.join('\n\n'),
    '</agent_memory>',
    '',
    'Plan Mode memory is read-only context. Do not update memory or call write/edit tools in Plan Mode.'
  ].join('\n');
}

function appendSystemText(message: SystemMessage, text: string): SystemMessage {
  const content = message.content;
  if (typeof content === 'string') {
    return new SystemMessage({ content: `${content}\n\n${text}` });
  }
  if (Array.isArray(content)) {
    return new SystemMessage({
      content: [
        ...content,
        {
          type: 'text',
          text
        }
      ]
    });
  }
  return new SystemMessage({ content: text });
}
