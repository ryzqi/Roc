import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import {
  readForgeMessageTag,
  readForgeNudgeVisibility
} from '../../../../../src/main/services/forge-guardrails';
import { createResponseValidationMiddleware } from '../../../../../src/main/services/forge-guardrails/middleware/response-validation';

function getAfterModelHook() {
  const middleware = createResponseValidationMiddleware({ knownToolNames: () => ['get_weather'] });
  const afterModel = middleware.afterModel;
  if (typeof afterModel !== 'object' || afterModel === null || typeof afterModel.hook !== 'function') {
    throw new Error('Expected response validation middleware to expose object-form afterModel hook.');
  }
  return afterModel;
}

async function runAfterModel(messages: unknown[]) {
  const update = await getAfterModelHook().hook({ messages } as never, {} as never);
  return update as { messages?: unknown[]; jumpTo?: 'model' | 'tools' | 'end' } | undefined;
}

describe('ForgeResponseValidation', () => {
  it('uses object-form afterModel with canJumpTo model', () => {
    expect(getAfterModelHook().canJumpTo).toEqual(['model']);
  });

  it('turns bare assistant text into a retry nudge and jumps back to the model', async () => {
    const update = await runAfterModel([
      new AIMessage({
        id: 'ai-bare',
        content: 'I can answer directly.'
      })
    ]);

    expect(update?.jumpTo).toBe('model');
    expect(update?.messages).toHaveLength(1);
    const nudge = update?.messages?.[0] as HumanMessage;
    expect(nudge).toBeInstanceOf(HumanMessage);
    expect(String(nudge.content)).toContain('不是合法的工具调用');
    expect(readForgeMessageTag(nudge)).toBe('forge:retry_nudge');
  });

  it('turns empty assistant output after tool work into a retry nudge and jumps back to the model', async () => {
    const update = await runAfterModel([
      new ToolMessage({
        id: 'tool-write',
        tool_call_id: 'call-write',
        name: 'write_file',
        content: 'Successfully wrote to /workspace/hello.docx',
        status: 'success'
      }),
      new AIMessage({
        id: 'ai-empty',
        content: ''
      })
    ]);

    expect(update?.jumpTo).toBe('model');
    expect(update?.messages).toHaveLength(1);
    const nudge = update?.messages?.[0] as HumanMessage;
    expect(nudge).toBeInstanceOf(HumanMessage);
    expect(String(nudge.content)).toContain('没有可见文本');
    expect(readForgeMessageTag(nudge)).toBe('forge:retry_nudge');
  });

  it('allows final assistant text after confirm_with_user has returned', async () => {
    const update = await runAfterModel([
      new ToolMessage({
        id: 'tool-confirm',
        tool_call_id: 'call-confirm',
        name: 'confirm_with_user',
        content: '{"ok":true}',
        status: 'success'
      }),
      new AIMessage({
        id: 'ai-final',
        content: '已创建后台任务。'
      })
    ]);

    expect(update).toBeUndefined();
  });

  it('turns unknown tool calls into tagged ToolMessages and jumps back to the model', async () => {
    const update = await runAfterModel([
      new AIMessage({
        id: 'ai-unknown',
        content: '',
        tool_calls: [
          {
            name: 'missing_tool',
            args: { city: 'Paris' },
            id: 'call-missing',
            type: 'tool_call'
          }
        ]
      })
    ]);

    expect(update?.jumpTo).toBe('model');
    const nudge = update?.messages?.[0] as ToolMessage;
    expect(nudge).toBeInstanceOf(ToolMessage);
    expect(nudge.tool_call_id).toBe('call-missing');
    expect(nudge.name).toBe('missing_tool');
    expect(nudge.status).toBe('error');
    expect(String(nudge.content)).toContain('[UnknownTool]');
    expect(String(nudge.content)).toContain('get_weather');
    expect(readForgeMessageTag(nudge)).toBe('forge:unknown_tool_nudge');
  });

  it('leaves valid tool calls unchanged', async () => {
    const update = await runAfterModel([
      new AIMessage({
        id: 'ai-valid',
        content: '',
        tool_calls: [
          {
            name: 'get_weather',
            args: { city: 'Paris' },
            id: 'call-weather',
            type: 'tool_call'
          }
        ]
      })
    ]);

    expect(update).toBeUndefined();
  });

  it('nudges a reasoning-only turn internally and jumps back to the model', async () => {
    const update = await runAfterModel([
      new AIMessage({
        id: 'ai-reasoning',
        content: [
          {
            type: 'reasoning',
            reasoning: '让我分析一下这个问题...'
          }
        ]
      })
    ]);

    expect(update?.jumpTo).toBe('model');
    expect(update?.messages).toHaveLength(1);
    const nudge = update?.messages?.[0] as HumanMessage;
    expect(nudge).toBeInstanceOf(HumanMessage);
    expect(String(nudge.content)).toContain('没有可见文本');
    expect(readForgeNudgeVisibility(nudge)).toBe('internal');
    expect(readForgeMessageTag(nudge)).toBe('forge:retry_nudge');
  });

  it('reproduces the docx run: a thinking-only turn must be retried, not accepted as final', async () => {
    const update = await runAfterModel([
      new AIMessage({
        id: 'ai-docx-thinking',
        content: [
          {
            type: 'reasoning',
            reasoning:
              'The user wants me to create a .docx file containing 你好世界. I should use the docx skill for this task. Let me first read the docx skill instructions.'
          }
        ]
      })
    ]);

    expect(update?.jumpTo).toBe('model');
    const nudge = update?.messages?.[0] as HumanMessage;
    expect(nudge).toBeInstanceOf(HumanMessage);
    expect(readForgeNudgeVisibility(nudge)).toBe('internal');
    expect(readForgeMessageTag(nudge)).toBe('forge:retry_nudge');
  });

  it('requires tool call when outputting text without reasoning', async () => {
    const update = await runAfterModel([
      new AIMessage({
        id: 'ai-bare-text',
        content: [
          {
            type: 'text',
            text: '我可以直接回答。'
          }
        ]
      })
    ]);

    expect(update?.jumpTo).toBe('model');
    expect(update?.messages).toHaveLength(1);
    const nudge = update?.messages?.[0] as HumanMessage;
    expect(String(nudge.content)).toContain('不是合法的工具调用');
  });

  it('allows text output when accompanied by reasoning', async () => {
    const update = await runAfterModel([
      new AIMessage({
        id: 'ai-mixed',
        content: [
          {
            type: 'reasoning',
            reasoning: '思考中...'
          },
          {
            type: 'text',
            text: '答案是42。'
          }
        ]
      })
    ]);

    expect(update).toBeUndefined();
  });

  it('normalizes Anthropic thinking blocks to reasoning via contentBlocks', async () => {
    const message = new AIMessage({
      id: 'ai-anthropic-thinking',
      content: [
        {
          type: 'thinking',
          thinking: 'Let me analyze this...',
          signature: 'WaUjzkyp...'
        },
        {
          type: 'text',
          text: 'The answer is 42.'
        }
      ],
      response_metadata: { model_provider: 'anthropic' }
    });

    const update = await runAfterModel([message]);

    expect(update).toBeUndefined();
  });
});
