export const DEFAULT_MCP_MAX_INBOUND_MESSAGE_BYTES = 1024 * 1024;

export class McpTransportMessageTooLargeError extends Error {
  readonly code = 'mcp_inbound_message_too_large';

  constructor(maxBytes: number) {
    super(`MCP inbound message exceeded ${maxBytes} bytes`);
    this.name = 'McpTransportMessageTooLargeError';
  }
}

export type BoundedMcpFetchOptions = {
  maxMessageBytes?: number;
  fetchImpl?: typeof fetch;
  onResponse?: (requestUrl: string, status: number) => void;
  onLimitExceeded?: () => void;
};

export function createBoundedMcpFetch(options: BoundedMcpFetchOptions = {}): typeof fetch {
  const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MCP_MAX_INBOUND_MESSAGE_BYTES;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1) {
    throw new Error('mcp_message_limit_invalid');
  }

  return async (input, init) => {
    const requestUrl = toRequestUrl(input);
    const response = await fetchImpl(input, init);
    options.onResponse?.(requestUrl, response.status);
    const body = response.body;
    if (body === null) {
      return response;
    }

    const isEventStream = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream';
    if (!isEventStream) {
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > maxMessageBytes) {
        options.onLimitExceeded?.();
        await body.cancel().catch(() => undefined);
        throw new McpTransportMessageTooLargeError(maxMessageBytes);
      }
    }

    const reader = body.getReader();
    const eventBudget = isEventStream ? new SseEventBudget(maxMessageBytes) : null;
    let responseBytes = 0;
    const boundedBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await reader.read();
          if (result.done) {
            controller.close();
            return;
          }
          const chunk = result.value;
          if (eventBudget !== null) {
            eventBudget.consume(chunk);
          } else {
            responseBytes += chunk.byteLength;
            if (responseBytes > maxMessageBytes) {
              throw new McpTransportMessageTooLargeError(maxMessageBytes);
            }
          }
          controller.enqueue(chunk);
        } catch (error) {
          if (isMcpTransportLimitError(error)) {
            options.onLimitExceeded?.();
          }
          await reader.cancel(error).catch(() => undefined);
          controller.error(error);
        }
      },
      async cancel(reason) {
        await reader.cancel(reason).catch(() => undefined);
      }
    }, { highWaterMark: 1 });

    return new Response(boundedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  };
}

function toRequestUrl(input: RequestInfo | URL): string {
  if (input instanceof Request) {
    return input.url;
  }
  return input instanceof URL ? input.href : String(input);
}

class SseEventBudget {
  private eventBytes = 0;
  private lineHasData = false;
  private previousWasCarriageReturn = false;

  constructor(private readonly maxMessageBytes: number) {}

  consume(chunk: Uint8Array): void {
    for (const byte of chunk) {
      this.eventBytes += 1;
      if (byte === 13) {
        this.finishLine();
        this.previousWasCarriageReturn = true;
      } else if (byte === 10) {
        if (this.previousWasCarriageReturn) {
          this.previousWasCarriageReturn = false;
          continue;
        }
        this.finishLine();
      } else {
        this.previousWasCarriageReturn = false;
        this.lineHasData = true;
      }
      if (this.eventBytes > this.maxMessageBytes) {
        throw new McpTransportMessageTooLargeError(this.maxMessageBytes);
      }
    }
  }

  private finishLine(): void {
    if (!this.lineHasData) {
      this.eventBytes = 0;
      return;
    }
    this.lineHasData = false;
  }
}

export function isMcpTransportLimitError(error: unknown): error is McpTransportMessageTooLargeError {
  return error instanceof McpTransportMessageTooLargeError;
}
