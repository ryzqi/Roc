import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

export const RESPOND_TOOL_NAME = 'respond';

const respondSchema = z.object({
  message: z.string().min(1).describe('要返回给用户的消息正文。')
});

const RESPOND_DESCRIPTION = [
  '当不需要再调其他工具、想给用户发文字时调用本工具。',
  '它把你的回复转化为一次结构化调用，框架会把它转回普通文本展示给用户。',
  '当你需要：',
  '- 用对话方式回应用户（如打招呼、答澄清问题），',
  '- 完成所有工作后给用户做总结，',
  '请调用本工具，而不是直接输出自由文本。'
].join('\n');

export function createRespondTool(): DynamicStructuredTool<
  typeof respondSchema,
  z.infer<typeof respondSchema>,
  z.infer<typeof respondSchema>,
  string
> {
  return new DynamicStructuredTool({
    name: RESPOND_TOOL_NAME,
    description: RESPOND_DESCRIPTION,
    schema: respondSchema,
    func: async ({ message }) => message
  });
}
