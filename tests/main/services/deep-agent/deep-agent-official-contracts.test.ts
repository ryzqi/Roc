import { createFilesystemMiddleware } from 'deepagents';
import { describe, expect, it } from 'vitest';
import type {
  AnyBackendProtocol,
  AsyncSubAgent,
  AsyncTaskStatus,
  CreateDeepAgentParams,
  SubAgent,
  SubagentRunStream
} from 'deepagents';
import { DEEP_AGENT_BUILT_IN_TOOLS } from '../../../../src/main/services/deep-agent/types';
import { createRocReadOnlyFilesystemPermissions } from '../../../../src/main/services/deep-agent/filesystem-tool-contract';

describe('DeepAgents official contract assumptions', () => {
  it('accepts async subagents through CreateDeepAgentParams', () => {
    const asyncSubagent: AsyncSubAgent = {
      name: 'remote-research',
      description: 'Run long research on an Agent Protocol server.',
      graphId: 'research_graph',
      url: 'http://127.0.0.1:2024'
    };

    const params = {
      subagents: [asyncSubagent]
    } satisfies Pick<CreateDeepAgentParams, 'subagents'>;

    expect(params.subagents?.[0]).toMatchObject({
      name: 'remote-research',
      graphId: 'research_graph'
    });
  });

  it('locks async task statuses used by Roc event payloads', () => {
    const statuses: AsyncTaskStatus[] = [
      'pending',
      'running',
      'success',
      'error',
      'cancelled',
      'timeout',
      'interrupted'
    ];

    expect(statuses).toEqual([
      'pending',
      'running',
      'success',
      'error',
      'cancelled',
      'timeout',
      'interrupted'
    ]);
  });

  it('documents native SubagentRunStream fields available to the projection layer', () => {
    type RequiredKeys = 'name' | 'cause' | 'output' | 'messages' | 'toolCalls' | 'subagents';
    const keys: RequiredKeys[] = ['name', 'cause', 'output', 'messages', 'toolCalls', 'subagents'];

    const assertKeys = (_keys: Array<keyof SubagentRunStream>): Array<keyof SubagentRunStream> => _keys;

    expect(assertKeys(keys)).toEqual(['name', 'cause', 'output', 'messages', 'toolCalls', 'subagents']);
  });

  it('keeps Roc built-in tool allowlist from exposing DeepAgents native execute', () => {
    expect(DEEP_AGENT_BUILT_IN_TOOLS).toEqual([
      'write_todos',
      'task',
      'ls',
      'read_file',
      'write_file',
      'edit_file',
      'glob',
      'grep'
    ]);
    expect(DEEP_AGENT_BUILT_IN_TOOLS).not.toContain('execute');
  });

  it('documents that DeepAgents filesystem middleware registers execute with file tools', () => {
    const middleware = createFilesystemMiddleware();
    const tools = middleware.tools;
    if (tools === undefined) {
      throw new Error('expected_filesystem_tools');
    }
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toEqual(expect.arrayContaining([
      'ls',
      'read_file',
      'write_file',
      'edit_file',
      'glob',
      'grep',
      'execute'
    ]));
    expect(DEEP_AGENT_BUILT_IN_TOOLS).not.toContain('execute');
  });

  it('documents that read-only permissions do not hide write tools from DeepAgents filesystem middleware', () => {
    const middleware = createFilesystemMiddleware({
      permissions: createRocReadOnlyFilesystemPermissions()
    });
    const tools = middleware.tools;
    if (tools === undefined) {
      throw new Error('expected_filesystem_tools');
    }
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toEqual(expect.arrayContaining([
      'ls',
      'read_file',
      'write_file',
      'edit_file',
      'glob',
      'grep'
    ]));
  });

  it('documents that empty DeepAgents permissions are permissive for file tools', async () => {
    const backend = {
      ls: async () => ({
        files: [{ path: '/outside/file.txt', is_dir: false, size: 5 }]
      }),
      read: async () => ({
        content: 'hello'
      }),
      readRaw: async () => ({
        data: {
          content: 'hello',
          mimeType: 'text/plain',
          created_at: '2026-06-04T00:00:00.000Z',
          modified_at: '2026-06-04T00:00:00.000Z'
        }
      }),
      write: async (filePath: string) => ({
        path: filePath,
        filesUpdate: null
      }),
      edit: async (filePath: string) => ({
        path: filePath,
        occurrences: 1,
        filesUpdate: null
      }),
      glob: async () => ({
        files: [{ path: '/outside/file.txt', is_dir: false, size: 5 }]
      }),
      grep: async () => ({
        matches: [{ path: '/outside/file.txt', line: 1, text: 'hello' }]
      }),
      uploadFiles: async () => [],
      downloadFiles: async () => []
    } satisfies AnyBackendProtocol;
    const middleware = createFilesystemMiddleware({ backend, permissions: [] });
    const tools = middleware.tools;
    if (tools === undefined) {
      throw new Error('expected_filesystem_tools');
    }
    const readTool = tools.find((tool) => tool.name === 'read_file');
    if (readTool === undefined) {
      throw new Error('expected_read_file_tool');
    }

    await expect(readTool.invoke({ file_path: '/outside/file.txt' })).resolves.toEqual([
      { type: 'text', text: '     1\thello' }
    ]);
  });

  it('documents that Roc passes memory and skills through createDeepAgent params', () => {
    const params = {
      memory: ['/memory/global/AGENTS.md', '/memory/workspaces/current/AGENTS.md'],
      skills: ['/skills/']
    } satisfies Pick<CreateDeepAgentParams, 'memory' | 'skills'>;

    expect(params.memory).toEqual(['/memory/global/AGENTS.md', '/memory/workspaces/current/AGENTS.md']);
    expect(params.skills).toEqual(['/skills/']);
  });

  it('documents that custom subagents must receive skills explicitly', () => {
    const subagent: SubAgent = {
      name: 'reviewer',
      description: 'Review implementation output.',
      systemPrompt: 'Review the result and report issues.',
      skills: ['/skills/']
    };

    expect(subagent.skills).toEqual(['/skills/']);
  });
});
