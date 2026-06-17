/**
 * 工具调用合法但参数对不上数据（HTTP 4xx 类）。
 *
 * 工具作者抛出后，wrapToolCall 中间件把它转为 ToolMessage
 * 喂回模型，不计入 consecutive_tool_errors，不记录步骤完成。
 */
export class RocToolResolutionError extends Error {
  readonly toolName: string | null;

  constructor(message: string, options?: { toolName?: string }) {
    super(message);
    this.name = 'RocToolResolutionError';
    this.toolName = options?.toolName ?? null;
  }
}

/**
 * forge 护栏耗尽时使用的错误代码命名空间。
 */
export const FORGE_EXHAUSTED_CODES = {
  retries: 'forge_retries_exhausted',
  toolErrors: 'forge_tool_errors_exhausted'
} as const;
