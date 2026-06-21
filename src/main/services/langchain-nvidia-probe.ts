import { resolveNvidiaBaseUrl } from '../../shared/provider-defaults';
import type { ProviderConfig } from '../../shared/types';
import { RocDomainError } from './errors';
import { buildNvidiaModelKwargs, type ModelFactoryLogService } from './langchain-provider-options';

type NvidiaProbeInput = {
  provider: ProviderConfig;
  modelId: string;
  prompt: string;
  apiKey: string;
  logService: ModelFactoryLogService | null;
  options?: { signal?: AbortSignal; timeoutMs?: number };
};

type JsonObject = Record<string, unknown>;

export async function probeNvidiaTtfb(input: NvidiaProbeInput): Promise<{ latencyMs: number }> {
  if (input.provider.type !== 'nvidia') {
    throw new RocDomainError({
      code: 'provider_type_unsupported',
      message: 'NVIDIA TTFB 探活仅适用于 NVIDIA Provider。',
      category: 'validation',
      retryable: false,
      userAction: '请使用 NVIDIA Provider 调用本方法。'
    });
  }
  const probeOptions = input.options ?? {};
  const baseUrl = resolveNvidiaBaseUrl(input.provider).replace(/\/+$/, '');
  const url = `${baseUrl}/chat/completions`;
  const modelKwargs = buildNvidiaModelKwargs(input.modelId, input.provider.options ?? {}, true);
  const startedAt = Date.now();
  const internalAbort = new AbortController();
  const timeoutMs = probeOptions.timeoutMs ?? 30_000;
  const hardTimeout = setTimeout(() => internalAbort.abort(), timeoutMs);
  const linkedSignal =
    probeOptions.signal === undefined
      ? internalAbort.signal
      : anySignal([probeOptions.signal, internalAbort.signal]);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream'
      },
      body: JSON.stringify({
        model: input.modelId,
        stream: true,
        max_tokens: 4,
        temperature: 0,
        messages: [{ role: 'user', content: input.prompt }],
        ...modelKwargs
      }),
      signal: linkedSignal
    });
    if (!response.ok) {
      const text = (await response.text()).slice(0, 300);
      throw new RocDomainError({
        code: 'provider_http_error',
        message: `Provider 请求失败：HTTP ${response.status}${text.length > 0 ? ` ${text}` : ''}`,
        category: 'external',
        retryable: response.status >= 500 || response.status === 429,
        userAction: '请检查 Provider endpoint、凭据、模型名称和服务状态后重试。'
      });
    }
    const body = response.body;
    if (body === null) {
      throw new RocDomainError({
        code: 'provider_response_malformed',
        message: 'Provider 流式响应缺少响应体。',
        category: 'external',
        retryable: true,
        userAction: '请稍后重试。'
      });
    }
    const reader = body.getReader();
    try {
      const decoder = new TextDecoder();
      let bufferedText = '';
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done === true) {
          throw new RocDomainError({
            code: 'provider_empty_response',
            message: 'Provider 返回了空回复。',
            category: 'external',
            retryable: true,
            userAction: '请稍后重试，或检查 Provider 模型配置。'
          });
        }
        bufferedText = `${bufferedText}${decoder.decode(chunk.value, { stream: true })}`;
        const parsed = readNvidiaProbeContent(bufferedText);
        bufferedText = parsed.remaining;
        if (parsed.hasContent) {
          return { latencyMs: Date.now() - startedAt };
        }
      }
    } finally {
      // 收到非空文本即可，无需继续读取——主动 cancel 让上游断开。
      try {
        await reader.cancel();
      } catch (cancelError) {
        const error = cancelError instanceof Error ? cancelError : new Error(String(cancelError));
        input.logService?.warn('NVIDIA probe response reader cancel failed.', {
          service: 'langchain-model-factory',
          component: 'probeNvidiaEndpoint',
          error: {
            code: 'reader_cancel_failed',
            message: error.message,
            stack: error.stack
          }
        });
      }
    }
  } catch (error) {
    if (isAbortLikeError(error) && internalAbort.signal.aborted && probeOptions.signal?.aborted !== true) {
      throw new RocDomainError({
        code: 'provider_request_timeout',
        message: `NVIDIA endpoint 未在 ${Math.round(timeoutMs / 1000)} 秒内返回首字节。`,
        category: 'external',
        retryable: true,
        userAction: '请稍后重试，或确认 NVIDIA 公共 endpoint 当前负载是否过高。'
      });
    }
    throw error;
  } finally {
    clearTimeout(hardTimeout);
  }
}

function readNvidiaProbeContent(raw: string): { hasContent: boolean; remaining: string } {
  const normalized = raw.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const rawEndsWithLineBreak = normalized.endsWith('\n');
  const completeLines = rawEndsWithLineBreak ? lines : lines.slice(0, -1);
  for (const line of completeLines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) {
      continue;
    }
    const payload = trimmed.slice('data:'.length).trim();
    if (payload.length === 0 || payload === '[DONE]') {
      continue;
    }
    try {
      if (readNvidiaProbePayloadContent(JSON.parse(payload) as unknown).trim().length > 0) {
        return {
          hasContent: true,
          remaining: rawEndsWithLineBreak ? '' : lines.at(-1)!
        };
      }
    } catch {
      throw new RocDomainError({
        code: 'provider_response_malformed',
        message: 'Provider 流式响应不符合 SSE chat completions 格式。',
        category: 'external',
        retryable: true,
        userAction: '请稍后重试，或检查 Provider endpoint 是否兼容 SSE。'
      });
    }
  }
  return {
    hasContent: false,
    remaining: rawEndsWithLineBreak ? '' : lines.at(-1)!
  };
}

function readNvidiaProbePayloadContent(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    return '';
  }
  return payload.choices
    .map((choice) => {
      if (!isRecord(choice) || !isRecord(choice.delta) || typeof choice.delta.content !== 'string') {
        return '';
      }
      return choice.delta.content;
    })
    .join('');
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAbortLikeError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') {
    return false;
  }
  const named = error as { name?: unknown; code?: unknown };
  return named.name === 'AbortError' || named.code === 'ABORT_ERR' || named.code === 20;
}

function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  if (typeof (AbortSignal as unknown as { any?: (signals: readonly AbortSignal[]) => AbortSignal }).any === 'function') {
    return (AbortSignal as unknown as { any: (signals: readonly AbortSignal[]) => AbortSignal }).any(signals);
  }
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener(
      'abort',
      () => controller.abort(signal.reason),
      { once: true }
    );
  }
  return controller.signal;
}
