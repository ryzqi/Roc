import { ToolMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';

const FILESYSTEM_TOOL_NAMES = new Set(['read_file', 'write_file', 'edit_file', 'ls', 'glob', 'grep']);

const ROUTE_OR_PERMISSION_ERROR_PATTERNS = [
  'Roc 文件工具只允许访问 /workspace/、/skills/、/memory/ 路径。',
  'Roc 已将 /skills/ 挂载为只读能力目录。',
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
  if (isRouteOrPermissionToolFailure(toolName, content)) {
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

function isRouteOrPermissionToolFailure(toolName: string, content: string): boolean {
  const trimmed = content.trim();
  if (ROUTE_OR_PERMISSION_ERROR_PATTERNS.some((pattern) => trimmed === pattern)) {
    return true;
  }
  if (toolName === 'read_file') {
    return ROUTE_OR_PERMISSION_ERROR_PATTERNS.some((pattern) => trimmed.startsWith(`Error: ${pattern}`));
  }
  if (toolName === 'ls') {
    return ROUTE_OR_PERMISSION_ERROR_PATTERNS.some((pattern) => trimmed.startsWith(`Error listing files: ${pattern}`));
  }
  if (toolName === 'glob') {
    return ROUTE_OR_PERMISSION_ERROR_PATTERNS.some((pattern) => trimmed.startsWith(`Error finding files: ${pattern}`));
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
