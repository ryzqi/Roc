import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';

import { isContextDigestMessage } from '../../../../../src/main/services/forge-guardrails/context-digest';
import {
  buildContextSummaryModelMessages,
  buildContextSummaryPrompt,
  contextSummaryToDigestMessage,
  parseContextSummary,
  summarizeWithCurrentModel
} from '../../../../../src/main/services/deep-agent/context/context-summary';

describe('context-summary', () => {
  it('parses a strict JSON context summary', () => {
    const summary = parseContextSummary(JSON.stringify({
      goal: 'Optimize context management.',
      facts: ['DeepAgents remains the harness.'],
      decisions: ['Use current run model for active summaries.'],
      filesTouched: ['src/main/services/deep-agent/context/context-summary.ts'],
      toolEvidence: ['read_file returned existing compaction middleware.'],
      verification: ['pnpm test target passed.'],
      openQuestions: ['None.'],
      nextActions: ['Wire middleware.']
    }));

    expect(summary.goal).toBe('Optimize context management.');
    expect(summary.decisions).toEqual(['Use current run model for active summaries.']);
  });

  it('rejects missing summary fields', () => {
    expect(() => parseContextSummary(JSON.stringify({
      goal: 'Missing fields.'
    }))).toThrow('context_summary_invalid');
  });

  it('parses fenced JSON context summaries', () => {
    const summary = parseContextSummary([
      '```json',
      JSON.stringify({
        goal: 'Optimize context management.',
        facts: ['DeepAgents remains the harness.'],
        decisions: ['Use current run model for active summaries.'],
        filesTouched: ['src/main/services/deep-agent/context/context-summary.ts'],
        toolEvidence: ['read_file returned existing compaction middleware.'],
        verification: ['pnpm test target passed.'],
        openQuestions: ['None.'],
        nextActions: ['Wire middleware.']
      }),
      '```'
    ].join('\n'));

    expect(summary.goal).toBe('Optimize context management.');
  });

  it('builds a summarization prompt without mutating system prompt blocks', () => {
    const prompt = buildContextSummaryPrompt({
      artifactReferences: ['artifactId: ctx_artifact_1'],
      goal: 'Keep context compact.',
      messages: [
        new HumanMessage({ id: 'user-old', content: 'Original request' }),
        new AIMessage({
          id: 'ai-old',
          content: '',
          tool_calls: [{
            id: 'call-old',
            name: 'read_file',
            args: { file_path: '/workspace/a.ts' },
            type: 'tool_call'
          }]
        }),
        new ToolMessage({
          id: 'tool-old',
          tool_call_id: 'call-old',
          name: 'read_file',
          content: 'file evidence',
          status: 'success'
        })
      ],
      recentMessages: [new AIMessage({ id: 'recent-ai', content: 'Recent analysis' })],
      userConstraints: ['Use DeepAgents native features first.'],
      workspacePath: 'F:\\Code\\Roc'
    });

    expect(prompt).toContain('Summarize old Roc runtime context.');
    expect(prompt).toContain('Use DeepAgents native features first.');
    expect(prompt).toContain('artifactId: ctx_artifact_1');
    expect(prompt).toContain('"file_path": "/workspace/a.ts"');
    expect(prompt).toContain('"tool_call_id": "call-old"');
    expect(prompt).toContain('"tool_name": "read_file"');
    expect(prompt).not.toContain('<!-- BLOCK:static:static:');
  });

  it('converts a valid summary to a protected context digest message', () => {
    const digest = contextSummaryToDigestMessage({
      goal: 'Finish context pipeline.',
      facts: ['Workspace is F:\\Code\\Roc.'],
      decisions: ['Use artifact store.'],
      filesTouched: ['src/main/services/deep-agent/context/context-artifact-store.ts'],
      toolEvidence: ['read_file showed existing context digest.'],
      verification: ['target tests pass'],
      openQuestions: ['None.'],
      nextActions: ['Wire middleware.']
    });

    expect(isContextDigestMessage(digest)).toBe(true);
    expect(String(digest.content)).toContain('Workspace is F:\\Code\\Roc.');
    expect(String(digest.content)).toContain('Use artifact store.');
    expect(String(digest.content)).toContain('read_file showed existing context digest.');
  });

  it('fails invalid JSON without issuing an unbudgeted corrective model call', async () => {
    const model = {
      invoke: vi
        .fn()
        .mockResolvedValue(new AIMessage('not json'))
    };

    await expect(summarizeWithCurrentModel({
      artifactReferences: [],
      goal: 'Summarize.',
      messages: [new HumanMessage('old')],
      model: model as never,
      recentMessages: [],
      userConstraints: [],
      workspacePath: null
    })).rejects.toThrow('context_summary_failed');

    expect(model.invoke).toHaveBeenCalledTimes(1);
  });

  it('builds the exact messages used by the summary model call', () => {
    const messages = buildContextSummaryModelMessages({
      artifactReferences: [],
      goal: 'Summarize.',
      messages: [new HumanMessage('old')],
      recentMessages: [],
      userConstraints: [],
      workspacePath: null
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]?.getType()).toBe('system');
    expect(String(messages[1]?.content)).toContain('Old messages:');
  });

  it('uses structured output and tags the summary call as internal', async () => {
    const structuredInvoke = vi.fn(async () => ({
      goal: 'Structured summary.',
      facts: [],
      decisions: [],
      filesTouched: [],
      toolEvidence: [],
      verification: [],
      openQuestions: [],
      nextActions: ['Continue.']
    }));
    const model = {
      invoke: vi.fn(async () => {
        throw new Error('plain_summary_invoke_not_expected');
      }),
      withStructuredOutput: vi.fn(() => ({
        invoke: structuredInvoke
      }))
    };

    const summary = await summarizeWithCurrentModel({
      artifactReferences: [],
      goal: 'Summarize.',
      messages: [new HumanMessage('old')],
      model: model as never,
      recentMessages: [],
      userConstraints: [],
      workspacePath: null
    });

    expect(summary.goal).toBe('Structured summary.');
    expect(model.withStructuredOutput).toHaveBeenCalledTimes(1);
    expect(model.invoke).not.toHaveBeenCalled();
    expect(structuredInvoke).toHaveBeenCalledTimes(1);
    expect(structuredInvoke).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        metadata: {
          lcSource: 'summarization'
        },
        tags: expect.arrayContaining(['nostream', 'roc-context-summary'])
      })
    );
  });

  it('falls back to plain JSON when the provider rejects structured output at invocation', async () => {
    const plainInvoke = vi.fn(async () => new AIMessage(JSON.stringify({
      goal: 'Plain fallback.',
      facts: [],
      decisions: [],
      filesTouched: [],
      toolEvidence: [],
      verification: [],
      openQuestions: [],
      nextActions: []
    })));
    const structuredInvoke = vi.fn(async () => {
      throw new Error('HTTP 400 response_format json_schema is not supported');
    });
    const model = {
      invoke: plainInvoke,
      withStructuredOutput: vi.fn(() => ({ invoke: structuredInvoke }))
    };

    const summary = await summarizeWithCurrentModel({
      artifactReferences: [],
      goal: 'Summarize.',
      messages: [new HumanMessage('old')],
      model: model as never,
      recentMessages: [],
      userConstraints: [],
      workspacePath: null
    });

    expect(summary.goal).toBe('Plain fallback.');
    expect(structuredInvoke).toHaveBeenCalledTimes(1);
    expect(plainInvoke).toHaveBeenCalledTimes(1);
  });
});
