import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';

import { isContextDigestMessage } from '../../../../../src/main/services/forge-guardrails/context-digest';
import {
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

  it('builds a summarization prompt without mutating system prompt blocks', () => {
    const prompt = buildContextSummaryPrompt({
      artifactReferences: ['artifactId: ctx_artifact_1'],
      goal: 'Keep context compact.',
      messages: [
        new HumanMessage({ id: 'user-old', content: 'Original request' }),
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

    expect(prompt).toContain('Summarize old Roc DeepAgents runtime context.');
    expect(prompt).toContain('Use DeepAgents native features first.');
    expect(prompt).toContain('artifactId: ctx_artifact_1');
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

  it('uses the current model and retries invalid JSON once', async () => {
    const model = {
      invoke: vi
        .fn()
        .mockResolvedValueOnce(new AIMessage('not json'))
        .mockResolvedValueOnce(new AIMessage(JSON.stringify({
          goal: 'Recovered summary.',
          facts: [],
          decisions: [],
          filesTouched: [],
          toolEvidence: [],
          verification: [],
          openQuestions: [],
          nextActions: ['Continue.']
        })))
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

    expect(summary.goal).toBe('Recovered summary.');
    expect(model.invoke).toHaveBeenCalledTimes(2);
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
        }
      })
    );
  });
});
