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

export type SummarizeWithCurrentModelInput = ContextSummaryInput & {
  model: Pick<BaseChatModel, 'invoke'>;
};

export async function summarizeWithCurrentModel(input: SummarizeWithCurrentModelInput): Promise<ContextSummary> {
  const prompt = buildContextSummaryPrompt(input);
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
  const response = await model.invoke([
    new SystemMessage('You summarize old runtime context for Roc.'),
    new HumanMessage(prompt)
  ] as never);
  if (typeof response.content === 'string') {
    return response.content;
  }
  return JSON.stringify(response.content);
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
