import { ToolMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';

const FILESYSTEM_TOOL_NAMES = new Set(['read_file', 'write_file', 'edit_file', 'ls', 'glob', 'grep']);

const ROUTE_OR_PERMISSION_ERROR_PATTERNS = [
  'Roc 当前只允许访问 /workspace/、/skills/、/agents/、/memory/ 路径。',
  'Roc 已将 /skills/ 挂载为只读能力目录。',
  'Roc 已将 /agents/ 挂载为只读项目规则目录。',
  'Roc 当前回合未启用这个 skill。',
  'permission_denied'
] as const;

export function createFilesystemToolErrorMiddleware() {
  return createMiddleware({
    name: 'ForgeFilesystemToolErrorMiddleware',
    wrapToolCall: async (request, handler) => {
      const result = await handler(request);
      if (!ToolMessage.isInstance(result)) {
        return result;
      }
      if (!FILESYSTEM_TOOL_NAMES.has(request.toolCall.name)) {
        return result;
      }
      if (!isHardFilesystemToolFailure(request.toolCall.name, readToolMessageText(result))) {
        return result;
      }
      return new ToolMessage({
        id: result.id,
        tool_call_id: result.tool_call_id,
        name: result.name,
        content: result.content,
        status: 'error'
      });
    }
  });
}

function isHardFilesystemToolFailure(toolName: string, content: string): boolean {
  if (ROUTE_OR_PERMISSION_ERROR_PATTERNS.some((pattern) => content.includes(pattern))) {
    return true;
  }
  if (toolName === 'write_file') {
    return content.startsWith('Cannot write to ') || content.startsWith('Error:');
  }
  if (toolName === 'edit_file') {
    return content.startsWith('Error:') || content.includes('not found') || content.includes('No replacement was performed');
  }
  if (toolName === 'glob') {
    return content.startsWith('Error finding files:');
  }
  return false;
}

function readToolMessageText(message: ToolMessage): string {
  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      if (typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string') {
        return part.text;
      }
      return '';
    })
    .filter((part) => part.length > 0)
    .join('\n');
}
