import { ToolMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import type { RTKBinaryManager } from './binary-manager';
import { CommandRewriter, isWindowsRtkDeniedSubcommand } from './rewriter';
import type { RewriteResult } from './rewriter';

type Rewriter = {
  rewrite(command: string): Promise<RewriteResult>;
};

export type RTKMiddlewareOptions = {
  rewriteTimeoutMs?: number;
  fallbackOnError?: boolean;
  createRewriter?: (binaryPath: string) => Rewriter;
};

const SHELL_TOOL_NAMES = new Set(['execute', 'bash', 'shell', 'terminal']);

export function createRTKMiddleware(binaryManager: RTKBinaryManager, options: RTKMiddlewareOptions = {}) {
  const fallbackOnError = options.fallbackOnError === undefined ? true : options.fallbackOnError;
  const rewriter = createRewriter(binaryManager, options);

  return createMiddleware({
    name: 'RTKMiddleware',
    wrapToolCall: async (request, handler) => {
      if (rewriter === null || !SHELL_TOOL_NAMES.has(request.toolCall.name)) {
        return handler(request);
      }

      const command = extractCommand(request.toolCall.args);
      if (command === null) {
        return handler(request);
      }

      let rewriteResult: RewriteResult;
      try {
        rewriteResult = await rewriter.rewrite(command);
      } catch (error) {
        if (fallbackOnError) {
          return handler(request);
        }
        throw error;
      }

      if (rewriteResult.exitCode === 2) {
        const toolCallId = request.toolCall.id === undefined ? `unknown_${request.toolCall.name}` : request.toolCall.id;
        return new ToolMessage({
          tool_call_id: toolCallId,
          name: request.toolCall.name,
          content: `RTK denied command: ${command}`,
          status: 'error'
        });
      }

      if (rewriteResult.rtkArgs !== null && isWindowsRtkDeniedSubcommand(rewriteResult.rtkArgs)) {
        return handler(request);
      }

      if (rewriteResult.rewritten === null) {
        return handler(request);
      }

      const rewrittenRequest = replaceCommand(request, rewriteResult.rewritten);
      try {
        return await handler(rewrittenRequest);
      } catch (error) {
        if (fallbackOnError) {
          return handler(request);
        }
        throw error;
      }
    }
  });
}

function createRewriter(binaryManager: RTKBinaryManager, options: RTKMiddlewareOptions): Rewriter | null {
  const binaryPath = binaryManager.getRTKBinaryPath();
  if (binaryPath === null || !binaryManager.isRTKAvailable()) {
    return null;
  }
  if (options.createRewriter !== undefined) {
    return options.createRewriter(binaryPath);
  }
  return new CommandRewriter(binaryPath, {
    timeoutMs: options.rewriteTimeoutMs
  });
}

function extractCommand(args: unknown): string | null {
  if (typeof args === 'string') {
    return args;
  }
  if (typeof args !== 'object' || args === null) {
    return null;
  }

  const commandArgs = args as Record<string, unknown>;
  for (const key of ['command', 'cmd', 'input']) {
    const value = commandArgs[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return null;
}

function replaceCommand<TRequest extends { toolCall: { args: unknown } }>(request: TRequest, command: string): TRequest {
  const originalArgs = request.toolCall.args;
  let args: unknown;

  if (typeof originalArgs === 'string') {
    args = command;
  } else if (typeof originalArgs === 'object' && originalArgs !== null) {
    const current = originalArgs as Record<string, unknown>;
    if ('command' in current) {
      args = { ...current, command };
    } else if ('cmd' in current) {
      args = { ...current, cmd: command };
    } else if ('input' in current) {
      args = { ...current, input: command };
    } else {
      args = { ...current, command };
    }
  } else {
    args = { command };
  }

  return {
    ...request,
    toolCall: {
      ...request.toolCall,
      args
    }
  };
}
