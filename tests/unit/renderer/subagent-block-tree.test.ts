import { describe, it, expect } from 'vitest';
import {
  SubagentBlockTree,
  DefaultTaskToolFilterPolicy,
  type TaskToolFilterPolicy
} from '../../../src/renderer/subagent-block-tree';
import type { ChatTranscriptActivityBlock } from '../../../src/renderer/chat-transcript';
import type { SubagentIdentity } from '../../../src/shared/types';

function createSubagentIdentity(id: string, parentId: string | null = null): SubagentIdentity {
  return {
    subagentId: id,
    parentSubagentId: parentId,
    name: `agent-${id}`,
    depth: parentId === null ? 0 : 1,
    path: parentId === null ? [id] : [parentId, id],
    execution: 'sync',
    taskInput: null
  };
}

describe('DefaultTaskToolFilterPolicy', () => {
  const policy = new DefaultTaskToolFilterPolicy();

  it('有子节点时不过滤 task 工具', () => {
    const block = { kind: 'tool_call' as const, name: 'task', id: 't1', status: 'end' as const, input: null, output: null, error: null };
    expect(policy.shouldFilter(block, { hasChildren: true })).toBe(false);
  });

  it('无子节点时过滤 task 工具', () => {
    const block = { kind: 'tool_call' as const, name: 'task', id: 't1', status: 'end' as const, input: null, output: null, error: null };
    expect(policy.shouldFilter(block, { hasChildren: false })).toBe(true);
  });

  it('无子节点时不过滤非 task 工具', () => {
    const block = { kind: 'tool_call' as const, name: 'bash', id: 't1', status: 'end' as const, input: null, output: null, error: null };
    expect(policy.shouldFilter(block, { hasChildren: false })).toBe(false);
  });

  it('无子节点时不过滤 text 块', () => {
    const block = { kind: 'text' as const, id: 't1', content: 'hello' };
    expect(policy.shouldFilter(block, { hasChildren: false })).toBe(false);
  });
});

describe('SubagentBlockTree.filterTaskToolsFromActivityBlocks', () => {
  it('空数组返回空数组', () => {
    const result = SubagentBlockTree.filterTaskToolsFromActivityBlocks([]);
    expect(result).toEqual([]);
  });

  it('无 subagent 块时不过滤顶层', () => {
    const blocks: ChatTranscriptActivityBlock[] = [
      { kind: 'tool_call', name: 'task', id: 't1', status: 'end', input: null, output: null, error: null },
      { kind: 'tool_call', name: 'bash', id: 't2', status: 'end', input: null, output: null, error: null }
    ];
    const result = SubagentBlockTree.filterTaskToolsFromActivityBlocks(blocks);
    expect(result).toBe(blocks); // 引用相同
  });

  it('有 subagent 块时过滤顶层 task 工具', () => {
    const blocks: ChatTranscriptActivityBlock[] = [
      {
        kind: 'subagent',
        id: 's1',
        identity: createSubagentIdentity('s1'),
        status: 'completed',
        summary: null,
        error: null,
        blocks: [],
        children: []
      },
      { kind: 'tool_call', name: 'task', id: 't1', status: 'end', input: null, output: null, error: null },
      { kind: 'tool_call', name: 'bash', id: 't2', status: 'end', input: null, output: null, error: null }
    ];
    const result = SubagentBlockTree.filterTaskToolsFromActivityBlocks(blocks);
    expect(result.length).toBe(2);
    expect(result[0].kind).toBe('subagent');
    expect(result[1]).toEqual({ kind: 'tool_call', name: 'bash', id: 't2', status: 'end', input: null, output: null, error: null });
  });

  it('无子节点的 subagent 内部过滤 task 工具', () => {
    const blocks: ChatTranscriptActivityBlock[] = [
      {
        kind: 'subagent',
        id: 's1',
        identity: createSubagentIdentity('s1'),
        status: 'completed',
        summary: null,
        error: null,
        blocks: [
          { kind: 'text', id: 'text1', content: 'hello' },
          { kind: 'tool_call', name: 'task', id: 't1', status: 'end', input: null, output: null, error: null },
          { kind: 'tool_call', name: 'bash', id: 't2', status: 'end', input: null, output: null, error: null }
        ],
        children: []
      }
    ];
    const result = SubagentBlockTree.filterTaskToolsFromActivityBlocks(blocks);
    expect(result.length).toBe(1);
    const subagent = result[0] as Extract<ChatTranscriptActivityBlock, { kind: 'subagent' }>;
    expect(subagent.blocks.length).toBe(2);
    expect(subagent.blocks[0]).toEqual({ kind: 'text', id: 'text1', content: 'hello' });
    expect(subagent.blocks[1]).toEqual({ kind: 'tool_call', name: 'bash', id: 't2', status: 'end', input: null, output: null, error: null });
  });

  it('有子节点的 subagent 内部保留所有块', () => {
    const blocks: ChatTranscriptActivityBlock[] = [
      {
        kind: 'subagent',
        id: 's1',
        identity: createSubagentIdentity('s1'),
        status: 'completed',
        summary: null,
        error: null,
        blocks: [
          { kind: 'tool_call', name: 'task', id: 't1', status: 'end', input: null, output: null, error: null },
          { kind: 'tool_call', name: 'bash', id: 't2', status: 'end', input: null, output: null, error: null }
        ],
        children: [
          {
            kind: 'subagent',
            id: 's2',
            identity: createSubagentIdentity('s2', 's1'),
            status: 'completed',
            summary: null,
            error: null,
            blocks: [],
            children: []
          }
        ]
      }
    ];
    const result = SubagentBlockTree.filterTaskToolsFromActivityBlocks(blocks);
    const subagent = result[0] as Extract<ChatTranscriptActivityBlock, { kind: 'subagent' }>;
    expect(subagent.blocks.length).toBe(2); // task 工具没被过滤
  });

  it('递归过滤嵌套 subagent', () => {
    const blocks: ChatTranscriptActivityBlock[] = [
      {
        kind: 'subagent',
        id: 's1',
        identity: createSubagentIdentity('s1'),
        status: 'completed',
        summary: null,
        error: null,
        blocks: [],
        children: [
          {
            kind: 'subagent',
            id: 's2',
            identity: createSubagentIdentity('s2', 's1'),
            status: 'completed',
            summary: null,
            error: null,
            blocks: [
              { kind: 'tool_call', name: 'task', id: 't1', status: 'end', input: null, output: null, error: null },
              { kind: 'tool_call', name: 'bash', id: 't2', status: 'end', input: null, output: null, error: null }
            ],
            children: []
          }
        ]
      }
    ];
    const result = SubagentBlockTree.filterTaskToolsFromActivityBlocks(blocks);
    const parent = result[0] as Extract<ChatTranscriptActivityBlock, { kind: 'subagent' }>;
    const child = parent.children[0];
    expect(child.blocks.length).toBe(1);
    expect(child.blocks[0]).toEqual({ kind: 'tool_call', name: 'bash', id: 't2', status: 'end', input: null, output: null, error: null });
  });

  it('自定义策略: 总是过滤 bash 工具', () => {
    const customPolicy: TaskToolFilterPolicy = {
      shouldFilter: (block) => block.kind === 'tool_call' && block.name === 'bash'
    };
    const blocks: ChatTranscriptActivityBlock[] = [
      {
        kind: 'subagent',
        id: 's1',
        identity: createSubagentIdentity('s1'),
        status: 'completed',
        summary: null,
        error: null,
        blocks: [
          { kind: 'tool_call', name: 'task', id: 't1', status: 'end', input: null, output: null, error: null },
          { kind: 'tool_call', name: 'bash', id: 't2', status: 'end', input: null, output: null, error: null }
        ],
        children: []
      }
    ];
    const result = SubagentBlockTree.filterTaskToolsFromActivityBlocks(blocks, customPolicy);
    const subagent = result[0] as Extract<ChatTranscriptActivityBlock, { kind: 'subagent' }>;
    expect(subagent.blocks.length).toBe(1);
    expect(subagent.blocks[0]).toEqual({ kind: 'tool_call', name: 'task', id: 't1', status: 'end', input: null, output: null, error: null });
  });
});
