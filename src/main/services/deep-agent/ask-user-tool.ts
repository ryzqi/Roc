import { DynamicStructuredTool } from '@langchain/core/tools';
import { interrupt } from '@langchain/langgraph';
import { z } from 'zod';

const askUserSchema = z.object({
  question: z.string().trim().min(1).describe('Question to ask the user before continuing.'),
  context: z.string().trim().min(1).optional().describe('Short context explaining why the question matters.'),
  suggestedResponses: z.array(z.string().trim().min(1)).optional().describe('Optional concise suggested answers.')
});

type AskUserInput = z.infer<typeof askUserSchema>;

type AskUserResumeValue =
  | string
  | {
      answer?: unknown;
    };

export function createAskUserTool(): DynamicStructuredTool<typeof askUserSchema, AskUserInput, AskUserInput, string> {
  return new DynamicStructuredTool<typeof askUserSchema, AskUserInput, AskUserInput, string>({
    name: 'ask_user',
    description: [
      'Pause and ask one concise clarification question.',
      'Use for a missing preference, scope, path, or other decision.',
      'Do not use for tool approval; HITL handles approval.'
    ].join('\n'),
    schema: askUserSchema,
    func: async (request) => {
      const resume = interrupt({
        kind: 'question',
        question: request.question,
        ...(request.context === undefined ? {} : { context: request.context }),
        ...(request.suggestedResponses === undefined ? {} : { suggestedResponses: request.suggestedResponses })
      }) as AskUserResumeValue;
      if (typeof resume === 'string') {
        return resume;
      }
      if (typeof resume === 'object' && resume !== null && typeof resume.answer === 'string') {
        return resume.answer;
      }
      throw new Error('ask_user_resume_answer_invalid');
    }
  });
}
