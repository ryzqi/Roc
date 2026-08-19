import { RocDomainError } from '../errors';
import {
  classifyProviderRequestFailure,
  isRetryableProviderHttpStatus,
  providerRequestTimeoutMessage
} from '../provider-request-retry';
import { redact } from './redaction';
import type { RunFailure } from './types';

const KNOWN_TRIGGER_KEYS = new Set(['type', 'description', 'cronExpression', 'nextRunAt']);
const KNOWN_PROPOSE_TOP_LEVEL_KEYS = new Set(['goal', 'trigger', 'workspacePath']);
const PROPOSE_TOOL_NAME = 'propose_background_task';
const PROPOSE_SCHEMA_SUGGESTION =
  'propose_background_task 模型只填写 goal 和 trigger；workspacePath、allowedActions、forbiddenActions、notificationPolicy、enabledCapabilities 由 runtime 设置。';

export function toRunFailure(error: unknown): RunFailure {
  if (error instanceof RocDomainError) {
    return {
      code: error.code,
      message: redact(error.message),
      retryable: error.retryable
    };
  }
  if (error instanceof Error) {
    const contextBudgetFailure = readContextBudgetFailure(error);
    if (contextBudgetFailure !== null) {
      return contextBudgetFailure;
    }
    const budgetFailure = readBudgetFailure(error);
    if (budgetFailure !== null) {
      return budgetFailure;
    }
    const toolFailure = readToolFailure(error);
    if (toolFailure !== null) {
      return toolFailure;
    }
  }
  const classification = classifyProviderRequestFailure(error);
  if (classification.kind === 'abort') {
    return {
      code: 'chat_run_cancelled',
      message: '当前运行已取消。',
      retryable: true
    };
  }
  if (classification.kind === 'http') {
    return {
      code: 'provider_http_error',
      message: `Provider 返回 HTTP ${classification.status}。`,
      retryable: isRetryableProviderHttpStatus(classification.status)
    };
  }
  if (error instanceof Error) {
    if (classification.kind === 'timeout') {
      return {
        code: 'provider_request_timeout',
        message: providerRequestTimeoutMessage,
        retryable: true
      };
    }
    if (classification.kind === 'network') {
      return {
        code: 'provider_network_error',
        message: `Provider 网络请求失败：${redact(error.message)}`,
        retryable: true
      };
    }
    return {
      code: 'provider_execution_failed',
      message: redact(error.message),
      retryable: true
    };
  }
  return {
    code: 'provider_execution_failed',
    message: 'Provider 执行失败。',
    retryable: true
  };
}

function readContextBudgetFailure(error: Error): RunFailure | null {
  if (error.message === 'context_budget_exhausted') {
    return {
      code: 'context_budget_exhausted',
      message: '上下文压缩后仍超过模型输入预算，已停止本轮执行。',
      retryable: false
    };
  }
  if (error.message === 'context_budget_profile_invalid') {
    return {
      code: 'context_budget_profile_invalid',
      message: '模型上下文窗口无法容纳系统、工具、输出和安全预留，已停止本轮执行。',
      retryable: false
    };
  }
  if (error.message === 'agent_context_budget_missing') {
    return {
      code: 'agent_context_budget_missing',
      message: '运行快照缺少模型上下文预算，已停止本轮执行。',
      retryable: false
    };
  }
  return null;
}

function readBudgetFailure(error: Error): RunFailure | null {
  if (error.name === 'ModelCallLimitMiddlewareError' || error.message.startsWith('Model call limits exceeded')) {
    return {
      code: 'run_budget_exhausted',
      message: '模型调用次数已达到本轮预算上限。',
      retryable: false
    };
  }
  if (error.name === 'ToolCallLimitExceededError' || error.message.includes('tool call limit reached')) {
    return {
      code: 'run_budget_exhausted',
      message: '工具调用次数已达到本轮预算上限。',
      retryable: false
    };
  }
  return null;
}

function readToolFailure(error: Error): RunFailure | null {
  const message = redact(error.message);
  const toolSchemaFailure = readToolSchemaFailure(message);
  if (toolSchemaFailure !== null) {
    return toolSchemaFailure;
  }
  if (message.startsWith('web_read 请求超时。')) {
    return {
      code: 'web_read_timeout',
      message,
      retryable: true
    };
  }
  if (message.startsWith('web_read 已取消。')) {
    return {
      code: 'web_read_aborted',
      message,
      retryable: false
    };
  }
  if (message.startsWith('web_read 拒绝包含 credentials')) {
    return {
      code: 'web_read_url_credentials',
      message,
      retryable: false
    };
  }
  if (message.startsWith('web_read 只允许公开网络地址')) {
    return {
      code: 'web_read_private_url',
      message,
      retryable: false
    };
  }
  if (message.startsWith('web_read 响应超过本地大小上限')) {
    return {
      code: 'web_read_response_too_large',
      message,
      retryable: false
    };
  }
  if (message.startsWith('web_read 请求失败：HTTP ')) {
    const statusMatch = /\bHTTP\s+(\d{3})\b/iu.exec(message);
    const status = statusMatch === null ? null : Number(statusMatch[1]);
    return {
      code: 'web_read_http_error',
      message,
      retryable: status === null ? true : status === 429 || status >= 500
    };
  }
  if (message.startsWith('web_read 未返回可读正文。')) {
    return {
      code: 'web_read_empty_response',
      message,
      retryable: true
    };
  }
  if (message.startsWith('web_read url 不能为空。')) {
    return {
      code: 'web_read_url_empty',
      message,
      retryable: false
    };
  }
  if (message.startsWith('web_read 只支持合法的 HTTP/HTTPS URL。')) {
    return {
      code: 'web_read_url_invalid',
      message,
      retryable: false
    };
  }
  if (message.startsWith('web_read timeoutSeconds 必须是 1 到 180 之间的整数。')) {
    return {
      code: 'web_read_timeout_invalid',
      message,
      retryable: false
    };
  }
  if (message.startsWith('web_read 请求失败')) {
    return {
      code: 'web_read_request_failed',
      message,
      retryable: true
    };
  }
  if (message.startsWith('web_search 不可用')) {
    return {
      code: 'web_search_unavailable',
      message,
      retryable: true
    };
  }
  if (message.startsWith('web_search 当前不可用。')) {
    return {
      code: 'web_search_unavailable',
      message,
      retryable: true
    };
  }
  return null;
}

function readToolSchemaFailure(message: string): RunFailure | null {
  if (!message.startsWith('Error invoking tool ')) {
    return null;
  }
  if (!/did not match expected schema|Received tool input did not match expected schema|Invalid input/iu.test(message)) {
    return null;
  }

  const toolName = readInvokedToolName(message);
  const schemaPath = readSchemaPath(message);
  const badKeys = readBadKeys(message);
  const failure: RunFailure = {
    code: 'tool_input_schema_invalid',
    diagnostic: {
      toolName,
      schemaPath,
      badKeys
    },
    message: `任务工具参数不符合 schema：${toolName} 的输入不符合工具契约。`,
    retryable: true
  };
  if (toolName === PROPOSE_TOOL_NAME) {
    failure.suggestion = PROPOSE_SCHEMA_SUGGESTION;
  }
  return failure;
}

function readInvokedToolName(message: string): string {
  const match = /^Error invoking tool ['"]([^'"]+)['"]/u.exec(message);
  if (match === null) {
    return '工具';
  }
  return match[1];
}

function readSchemaPath(message: string): string | undefined {
  const match = /\bat\s+([A-Za-z0-9_.]+)\b/u.exec(message);
  return match?.[1];
}

function readBadKeys(message: string): string[] {
  const kwargsMatch = /\bkwargs\s+(\{[\s\S]*?\})\s+with error:/u.exec(message);
  if (kwargsMatch === null) {
    return [];
  }
  const topLevelKeys = readTopLevelObjectKeys(kwargsMatch[1]);
  const badTopLevelKeys = topLevelKeys.filter((key) => !KNOWN_PROPOSE_TOP_LEVEL_KEYS.has(key));
  const triggerKeys = readTriggerKeys(kwargsMatch[1]);
  const badTriggerKeys = triggerKeys.filter((key) => !KNOWN_TRIGGER_KEYS.has(key)).map((key) => `trigger.${key}`);
  const badKeys = [...badTopLevelKeys, ...badTriggerKeys];
  return [...new Set(badKeys)].slice(0, 5);
}

function readTriggerKeys(kwargsText: string): string[] {
  const triggerMatch = /['"]trigger['"]\s*:\s*\{([\s\S]*?)\}/u.exec(kwargsText);
  if (triggerMatch === null) {
    return [];
  }
  return readObjectKeys(triggerMatch[1]);
}

function readObjectKeys(objectText: string): string[] {
  return [...objectText.matchAll(/['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*:/gu)].map((match) => match[1]);
}

function readTopLevelObjectKeys(objectText: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  for (let index = 0; index < objectText.length; index += 1) {
    const char = objectText[index];
    const previous = index === 0 ? '' : objectText[index - 1];
    if ((char === "'" || char === '"') && previous !== '\\') {
      if (quote === null) {
        quote = char;
        const keyMatch = /^['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*:/u.exec(objectText.slice(index));
        if (depth === 1 && keyMatch !== null) {
          keys.push(keyMatch[1]);
        }
      } else if (quote === char) {
        quote = null;
      }
      continue;
    }
    if (quote !== null) {
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
    }
  }
  return keys;
}
