import { SystemMessage } from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import type { FileDownloadResponse, FileInfo, GlobResult, GrepMatch, GrepResult, LsResult, ReadResult } from 'deepagents';
import { createMiddleware } from 'langchain';
import { z } from 'zod';
import type { RocCompositeBackend } from './backend';

const DEFAULT_PLAN_READ_PATH = '/workspace/';

const lsSchema = z.object({
  path: z.string().trim().min(1).optional().default(DEFAULT_PLAN_READ_PATH)
});

const readFileSchema = z.object({
  file_path: z.string().trim().min(1),
  offset: z.coerce.number().int().min(0).optional().default(0),
  limit: z.coerce.number().int().positive().max(1000).optional().default(100)
});

const globSchema = z.object({
  pattern: z.string().trim().min(1),
  path: z.string().trim().min(1).optional().default(DEFAULT_PLAN_READ_PATH)
});

const grepSchema = z.object({
  pattern: z.string().trim().min(1),
  path: z.string().trim().min(1).optional().default(DEFAULT_PLAN_READ_PATH),
  glob: z.string().trim().min(1).optional().nullable().default(null)
});

const planMemoryStateSchema = z.object({
  roc_plan_memory_contents: z.record(z.string(), z.string()).optional()
});

type LsInput = z.infer<typeof lsSchema>;
type ReadFileInput = z.infer<typeof readFileSchema>;
type GlobInput = z.infer<typeof globSchema>;
type GrepInput = z.infer<typeof grepSchema>;
type PlanReadResult = ReadResult | string;

export function createRocPlanReadOnlyFilesystemTools(backend: RocCompositeBackend) {
  return [
    createPlanLsTool(backend),
    createPlanReadFileTool(backend),
    createPlanGlobTool(backend),
    createPlanGrepTool(backend)
  ];
}

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

function createPlanLsTool(backend: RocCompositeBackend) {
  return new DynamicStructuredTool<typeof lsSchema, LsInput, LsInput, string>({
    name: 'ls',
    description: 'List files under Roc virtual read-only routes such as /workspace/, /memory/, or /skills/.',
    schema: lsSchema,
    func: async (input) => {
      const result = await readBackendLs(backend, input.path);
      if (result.error !== undefined) {
        return `Error listing files: ${result.error}`;
      }
      const files = result.files;
      if (files === undefined || files.length === 0) {
        return `No files found in ${input.path}`;
      }
      return files
        .map((file: FileInfo) => {
          const size = file.size === undefined ? '' : ` (${file.size} bytes)`;
          return file.is_dir === true ? `${file.path} (directory)` : `${file.path}${size}`;
        })
        .join('\n');
    }
  });
}

function createPlanReadFileTool(backend: RocCompositeBackend) {
  return new DynamicStructuredTool<typeof readFileSchema, ReadFileInput, ReadFileInput, string>({
    name: 'read_file',
    description: 'Read a file from Roc virtual read-only routes. Use offset and limit for large files.',
    schema: readFileSchema,
    func: async (input) => {
      const result = await readBackendFile(backend, input.file_path, input.offset, input.limit);
      if (typeof result === 'string') {
        return formatWithLineNumbers(result, input.offset);
      }
      if (result.error !== undefined) {
        return `Error reading file: ${result.error}`;
      }
      if (typeof result.content !== 'string') {
        return `Error reading file: ${input.file_path} is not text content.`;
      }
      return formatWithLineNumbers(result.content, input.offset);
    }
  });
}

function createPlanGlobTool(backend: RocCompositeBackend) {
  return new DynamicStructuredTool<typeof globSchema, GlobInput, GlobInput, string>({
    name: 'glob',
    description: 'Find files matching a glob pattern under Roc virtual read-only routes.',
    schema: globSchema,
    func: async (input) => {
      const result = await readBackendGlob(backend, input.pattern, input.path);
      if (result.error !== undefined) {
        return `Error finding files: ${result.error}`;
      }
      const files = result.files;
      if (files === undefined || files.length === 0) {
        return `No files found matching pattern '${input.pattern}'`;
      }
      return files.map((file: FileInfo) => file.path).join('\n');
    }
  });
}

function createPlanGrepTool(backend: RocCompositeBackend) {
  return new DynamicStructuredTool<typeof grepSchema, GrepInput, GrepInput, string>({
    name: 'grep',
    description: 'Search for literal text under Roc virtual read-only routes.',
    schema: grepSchema,
    func: async (input) => {
      const result = await readBackendGrep(backend, input.pattern, input.path, input.glob);
      if (result.error !== undefined) {
        return `Error searching files: ${result.error}`;
      }
      const matches = result.matches;
      if (matches === undefined || matches.length === 0) {
        return `No matches found for pattern '${input.pattern}'`;
      }
      return matches.map((match: GrepMatch) => `${match.path}:${match.line}: ${match.text}`).join('\n');
    }
  });
}

async function readBackendLs(backend: RocCompositeBackend, path: string): Promise<LsResult> {
  const ls = readBackendMethod<[string], LsResult>(backend, 'ls');
  return await ls(path);
}

async function readBackendFile(
  backend: RocCompositeBackend,
  filePath: string,
  offset: number,
  limit: number
): Promise<PlanReadResult> {
  const read = readBackendMethod<[string, number, number], PlanReadResult>(backend, 'read');
  return await read(filePath, offset, limit);
}

async function readBackendGlob(backend: RocCompositeBackend, pattern: string, path: string): Promise<GlobResult> {
  const glob = readBackendMethod<[string, string], GlobResult>(backend, 'glob');
  return await glob(pattern, path);
}

async function readBackendGrep(
  backend: RocCompositeBackend,
  pattern: string,
  path: string,
  glob: string | null
): Promise<GrepResult> {
  const grep = readBackendMethod<[string, string, string | null], GrepResult>(backend, 'grep');
  return await grep(pattern, path, glob);
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

function formatWithLineNumbers(content: string, offset: number): string {
  if (content.length === 0) {
    return '[File is empty]';
  }
  return content
    .split('\n')
    .map((line, index) => `${String(offset + index + 1).padStart(6)}\t${line}`)
    .join('\n');
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
