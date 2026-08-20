import { afterEach, describe, expect, it, vi } from 'vitest';

import { probeNvidiaTtfb } from '../../src/main/services/langchain-nvidia-probe';
import type { ProviderConfig } from '../../src/shared/types';

const provider = {
  id: 'nvidia',
  name: 'NVIDIA',
  type: 'nvidia',
  endpoint: 'https://integrate.api.nvidia.com/v1',
  credentialRef: 'secret:nvidia',
  enabled: true,
  models: [
    {
      id: 'meta/llama-3.3-70b-instruct',
      displayName: 'Llama 3.3 70B',
      enabled: true,
      supportsStreaming: true,
      supportsToolCalls: true,
      supportsImages: false
    }
  ]
} satisfies ProviderConfig;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('probeNvidiaTtfb', () => {
  it('returns after the first non-empty SSE content delta and cancels the reader', async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"2"}}]}\n\n'));
      },
      cancel() {
        cancelled = true;
      }
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await probeNvidiaTtfb({
      provider,
      modelId: 'meta/llama-3.3-70b-instruct',
      modelOptions: {},
      prompt: 'What is 1+1?',
      apiKey: 'nvapi-test',
      logService: null
    });

    const call = fetchMock.mock.calls[0];
    if (call === undefined) {
      throw new Error('fetch_not_called');
    }
    const [url, init] = call;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(cancelled).toBe(true);
    expect(url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer nvapi-test',
        'Content-Type': 'application/json',
        Accept: 'text/event-stream'
      }
    });
    expect(body).toMatchObject({
      model: 'meta/llama-3.3-70b-instruct',
      stream: true,
      max_tokens: 4,
      temperature: 0,
      messages: [{ role: 'user', content: 'What is 1+1?' }]
    });
  });

  it('maps the internal hard timeout to provider_request_timeout', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('The operation was aborted.', 'AbortError')),
          { once: true }
        );
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const resultPromise = probeNvidiaTtfb({
      provider,
      modelId: 'meta/llama-3.3-70b-instruct',
      modelOptions: {},
      prompt: 'What is 1+1?',
      apiKey: 'nvapi-test',
      logService: null,
      options: { timeoutMs: 1_000 }
    });
    const resultAssertion = expect(resultPromise).rejects.toMatchObject({
      code: 'provider_request_timeout'
    });
    await vi.advanceTimersByTimeAsync(1_000);

    await resultAssertion;
  });

  it('preserves caller aborts instead of reporting them as provider timeouts', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('Caller cancelled.', 'AbortError'));
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted === true) {
        return Promise.reject(new DOMException('Caller cancelled.', 'AbortError'));
      }
      return Promise.resolve(new Response('', { status: 204 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      probeNvidiaTtfb({
        provider,
        modelId: 'meta/llama-3.3-70b-instruct',
        modelOptions: {},
        prompt: 'What is 1+1?',
        apiKey: 'nvapi-test',
        logService: null,
        options: { signal: controller.signal, timeoutMs: 30_000 }
      })
    ).rejects.toMatchObject({
      name: 'AbortError'
    });
  });
});
