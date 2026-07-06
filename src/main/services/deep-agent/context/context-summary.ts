import { AIMessage, BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { z } from 'zod';

import { createContextDigestMessage } from '../../forge-guardrails/context-digest';

const contextSummarySchema = z.object({
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
};

const contextSummaryInvokeConfig = {
  metadata: {
    lcSource: 'summarization'
  },
  tags: ['roc-context-summary']
};

export async function summarizeWithCurrentModel(input: SummarizeWithCurrentModelInput): Promise<ContextSummary> {
  const prompt = buildContextSummaryPrompt(input);
  const structuredSummary = await summarizeWithStructuredOutput(input.model, prompt);
  if (structuredSummary !== null) {
    return structuredSummary;
  }
  const first = await invokeSummaryModel(input.model, prompt);
  try {
    return parseContextSummary(first);
  } catch {
    const correctivePrompt = [
      'Return only valid JSON matching the required context summary schema.',
      'Do not include Markdown fences or explanatory text.',
      'Previous invalid output:',
      first
    ].join('\n');
    const second = await invokeSummaryModel(input.model, correctivePrompt);
    try {
      return parseContextSummary(second);
    } catch {
      throw new Error('context_summary_failed');
    }
  }
}

async function summarizeWithStructuredOutput(model: ContextSummaryModel, prompt: string): Promise<ContextSummary | null> {
  const withStructuredOutput = model.withStructuredOutput;
  if (withStructuredOutput === undefined) {
    return null;
  }

  let structuredModel: ReturnType<BaseChatModel['withStructuredOutput']>;
  try {
    structuredModel = withStructuredOutput.call(model, contextSummarySchema, {
      name: 'roc_context_summary'
    });
  } catch (error) {
    if (isStructuredOutputUnavailable(error)) {
      return null;
    }
    throw error;
  }

  try {
    const summary = await structuredModel.invoke(buildContextSummaryMessages(prompt), contextSummaryInvokeConfig);
    return contextSummarySchema.parse(summary);
  } catch {
    throw new Error('context_summary_failed');
  }
}

export function buildContextSummaryPrompt(input: ContextSummaryInput): string {
  return [
    'Summarize old Roc DeepAgents runtime context.',
    'Return only JSON with keys: goal, facts, decisions, filesTouched, toolEvidence, verification, openQuestions, nextActions.',
    'Do not invent facts. Keep summaries compact and evidence-linked.',
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

export function parseContextSummary(text: string): ContextSummary {
  try {
    const parsed = JSON.parse(text);
    return contextSummarySchema.parse(parsed);
  } catch {
    throw new Error('context_summary_invalid');
  }
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

async function invokeSummaryModel(model: Pick<BaseChatModel, 'invoke'>, prompt: string): Promise<string> {
  const response = await model.invoke(buildContextSummaryMessages(prompt), contextSummaryInvokeConfig);
  if (typeof response.content === 'string') {
    return response.content;
  }
  return JSON.stringify(response.content);
}

function buildContextSummaryMessages(prompt: string): BaseMessage[] {
  return [
    new SystemMessage('You summarize old runtime context for Roc.'),
    new HumanMessage(prompt)
  ];
}

function isStructuredOutputUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.message.includes('withStructuredOutput') ||
    error.message.includes('bindTools') ||
    error.message.includes('structured output')
  );
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
      additional_kwargs: message.additional_kwargs
    })),
    null,
    2
  );
}
