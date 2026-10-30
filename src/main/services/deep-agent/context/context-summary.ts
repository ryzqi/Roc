import { AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { z } from 'zod';

import type { RunnableConfig } from '@langchain/core/runnables';
import { createContextDigestMessage } from '../../forge-guardrails/context-digest';
import { readStructuredModelResponse, type RunBudgetObserver } from '../run-budget-observer';

export const contextSummarySchema = z.object({
  goal: z.string(),
  facts: z.array(z.string()),
  decisions: z.array(z.string()),
  filesTouched: z.array(z.string()),
  toolEvidence: z.array(z.string()),
  verification: z.array(z.string()),
  openQuestions: z.array(z.string()),
  nextActions: z.array(z.string())
});

export type ContextSummary = z.infer<typeof contextSummarySchema>;

export type ContextSummaryInput = {
  artifactReferences: readonly string[];
  goal: string;
  messages: readonly BaseMessage[];
  recentMessages: readonly BaseMessage[];
  userConstraints: readonly string[];
  workspacePath: string | null;
};

type ContextSummaryModel = Pick<BaseChatModel, 'invoke'> & {
  withStructuredOutput?: BaseChatModel['withStructuredOutput'];
};

export type SummarizeWithCurrentModelInput = ContextSummaryInput & {
  model: ContextSummaryModel;
  callbacks?: RunnableConfig['callbacks'];
  budgetObserver?: RunBudgetObserver;
};

const contextSummaryInvokeConfig = {
  metadata: {
    lcSource: 'summarization'
  },
  tags: ['nostream', 'roc-context-summary']
};

export async function summarizeWithCurrentModel(input: SummarizeWithCurrentModelInput): Promise<ContextSummary> {
  const messages = buildContextSummaryModelMessages(input);
  const structuredSummary = await summarizeWithStructuredOutput(input.model, messages, input.callbacks, input.budgetObserver);
  if (structuredSummary !== null) {
    return structuredSummary;
  }
  const first = await invokeSummaryModel(input.model, messages, input.callbacks, input.budgetObserver);
  try {
    return parseContextSummary(first);
  } catch {
    throw new Error('context_summary_failed');
  }
}

async function summarizeWithStructuredOutput(
  model: ContextSummaryModel,
  messages: BaseMessage[],
  callbacks: RunnableConfig['callbacks'],
  budgetObserver: RunBudgetObserver | undefined
): Promise<ContextSummary | null> {
  const withStructuredOutput = model.withStructuredOutput;
  if (withStructuredOutput === undefined) {
    return null;
  }

  let structuredModel: ReturnType<BaseChatModel['withStructuredOutput']>;
  try {
    structuredModel = withStructuredOutput.call(model, contextSummarySchema, {
      name: 'roc_context_summary',
      includeRaw: true
    });
  } catch (error) {
    if (isStructuredOutputUnavailable(error)) {
      return null;
    }
    throw error;
  }

  let summary: unknown;
  try {
    const invoke = () => structuredModel.invoke(messages, { ...contextSummaryInvokeConfig, callbacks });
    const response = budgetObserver === undefined
      ? await invoke()
      : await budgetObserver.invoke({
          messages,
          purpose: 'summary',
          responseMessage: (result) => readStructuredModelResponse(result)?.raw ?? null,
          invoke
        });
    const structuredResponse = readStructuredModelResponse(response);
    summary = structuredResponse === null ? response : structuredResponse.parsed;
  } catch (error) {
    if (isStructuredOutputUnavailable(error)) {
      return null;
    }
    throw error;
  }
  const parsed = contextSummarySchema.safeParse(summary);
  if (!parsed.success) {
    throw new Error('context_summary_failed');
  }
  return parsed.data;
}

export function buildContextSummaryPrompt(input: ContextSummaryInput): string {
  return [
    'Summarize old Roc runtime context.',
    'Return only JSON with keys: goal, facts, decisions, filesTouched, toolEvidence, verification, openQuestions, nextActions.',
    'Do not invent facts. Keep each item compact and evidence-linked.',
    `Current goal: ${input.goal}`,
    `Workspace: ${input.workspacePath === null ? 'not selected' : input.workspacePath}`,
    'User constraints:',
    ...formatList(input.userConstraints),
    'Persisted artifact references:',
    ...formatList(input.artifactReferences),
    'Old messages:',
    serializeMessages(input.messages),
    'Recent messages to preserve continuity:',
    serializeMessages(input.recentMessages)
  ].join('\n');
}

export function buildContextSummaryModelMessages(input: ContextSummaryInput): BaseMessage[] {
  return [
    new SystemMessage('Summarize Roc runtime context.'),
    new HumanMessage(buildContextSummaryPrompt(input))
  ];
}

export function parseContextSummary(text: string): ContextSummary {
  const candidates = [text, unwrapJsonFence(text)];
  for (const candidate of candidates) {
    try {
      return contextSummarySchema.parse(JSON.parse(candidate));
    } catch {
      continue;
    }
  }
  throw new Error('context_summary_invalid');
}

function unwrapJsonFence(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized.startsWith('```')) {
    return text;
  }
  const rest = normalized.slice(3);
  const newlineIndex = rest.indexOf('\n');
  if (newlineIndex === -1) {
    return text;
  }
  const language = rest.slice(0, newlineIndex).trim();
  if (language.length > 0 && language !== 'json') {
    return text;
  }
  let body = rest.slice(newlineIndex + 1);
  if (body.endsWith('```')) {
    body = body.slice(0, -3);
    if (body.endsWith('\n')) {
      body = body.slice(0, -1);
    }
  }
  return body.trim();
}

export function contextSummaryToDigestMessage(summary: ContextSummary): AIMessage {
  return createContextDigestMessage({
    facts: summary.facts,
    decisions: summary.decisions,
    filesTouched: summary.filesTouched,
    verifications: [...summary.toolEvidence, ...summary.verification],
    openQuestions: summary.openQuestions,
    nextActions: summary.nextActions
  });
}

async function invokeSummaryModel(
  model: Pick<BaseChatModel, 'invoke'>,
  messages: BaseMessage[],
  callbacks: RunnableConfig['callbacks'],
  budgetObserver: RunBudgetObserver | undefined
): Promise<string> {
  const invoke = () => model.invoke(messages, { ...contextSummaryInvokeConfig, callbacks });
  const response = budgetObserver === undefined
    ? await invoke()
    : await budgetObserver.invoke({
        messages,
        purpose: 'summary',
        responseMessage: (result) => result,
        invoke
      });
  if (typeof response.content === 'string') {
    return response.content;
  }
  return JSON.stringify(response.content);
}

function isStructuredOutputUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /withStructuredOutput|bindTools|structured output|response_format|json_schema.+(?:not supported|unsupported)|(?:not supported|unsupported).+json schema/iu.test(error.message);
}

function formatList(values: readonly string[]): string[] {
  if (values.length === 0) {
    return ['- none'];
  }
  return values.map((value) => `- ${value}`);
}

function serializeMessages(messages: readonly BaseMessage[]): string {
  return JSON.stringify(
    messages.map((message) => ({
      id: message.id,
      type: message.getType(),
      content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
      additional_kwargs: message.additional_kwargs,
      invalid_tool_calls: AIMessage.isInstance(message) ? message.invalid_tool_calls : undefined,
      tool_call_id: ToolMessage.isInstance(message) ? message.tool_call_id : undefined,
      tool_calls: AIMessage.isInstance(message) ? message.tool_calls : undefined,
      tool_name: ToolMessage.isInstance(message) ? message.name : undefined,
      tool_status: ToolMessage.isInstance(message) ? message.status : undefined
    })),
    null,
    2
  );
}
