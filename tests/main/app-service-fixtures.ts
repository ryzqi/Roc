import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { createAppServices, type AppServices } from '../../src/main/services/app-service';
import type { RuntimeMetricsProvider } from '../../src/main/services/diagnostics-service';

export type AppServicesTestContext = {
  root: string;
  services: AppServices;
};

export function initializeAppServicesTest(
  options: { skipInitialize?: boolean; runtimeMetrics?: RuntimeMetricsProvider } = {}
): AppServicesTestContext {
  const root = mkdtempSync(join(tmpdir(), 'roc-test-'));
  const services = createAppServices(root, undefined, undefined, options.runtimeMetrics);
  if (options.skipInitialize !== true) {
    services.appService.initialize();
  }
  services.providerRuntimeService.setDeterministicResponse({
    content: 'Provider runtime 测试回复。',
    finishReason: 'stop',
    promptTokens: 8,
    completionTokens: 6
  });
  return {
    root,
    services
  };
}

export function cleanupAppServicesTest(input: AppServicesTestContext): void {
  input.services.appService.shutdown();
  rmSync(input.root, { recursive: true, force: true });
}

export function normalizeLineEndings(value: string): string {
  return value.replaceAll('\r\n', '\n');
}

function readHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  return value;
}

type CapturedProviderRequest = {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  xApiKey: string | undefined;
  anthropicVersion: string | undefined;
  contentType: string | undefined;
  rawBody: string;
  body: unknown;
};

export type FakeProvider = {
  endpoint: string;
  requests: CapturedProviderRequest[];
  close: () => Promise<void>;
};

type FakeProviderResponseOptions = {
  contentType?: string;
  rawBody?: string;
};

type FakeProviderResponseStep = {
  body: unknown;
  statusCode: number;
  options?: FakeProviderResponseOptions;
};

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on('error', rejectBody);
    request.on('end', () => {
      resolveBody(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

export async function startFakeProvider(
  responseBody: unknown,
  statusCode: number,
  options: FakeProviderResponseOptions = {}
): Promise<FakeProvider> {
  return await startFakeProviderSequence([
    {
      body: responseBody,
      statusCode,
      options
    }
  ]);
}

export async function startFakeProviderSequence(
  responseSteps: readonly FakeProviderResponseStep[]
): Promise<FakeProvider> {
  if (responseSteps.length === 0) {
    throw new Error('Fake provider response sequence must contain at least one step.');
  }
  const requests: CapturedProviderRequest[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const responseStep = responseSteps[Math.min(requests.length, responseSteps.length - 1)]!;
      const rawBody = await readBody(request);
      const parsedBody = rawBody.length === 0 ? null : (JSON.parse(rawBody) as unknown);
      requests.push({
        method: request.method,
        url: request.url,
        authorization: readHeader(request.headers.authorization),
        xApiKey: readHeader(request.headers['x-api-key']),
        anthropicVersion: readHeader(request.headers['anthropic-version']),
        contentType: readHeader(request.headers['content-type']),
        rawBody,
        body: parsedBody
      });
      response.statusCode = responseStep.statusCode;
      response.setHeader('content-type', responseStep.options?.contentType ?? 'application/json');
      response.end(responseStep.options?.rawBody ?? JSON.stringify(responseStep.body));
    })().catch((error: unknown) => {
      response.statusCode = 500;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : 'fake provider request failed'
        })
      );
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Fake provider did not expose a TCP address.');
  }
  const tcpAddress = address as AddressInfo;

  return {
    endpoint: `http://127.0.0.1:${tcpAddress.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error !== undefined) {
            rejectClose(error);
            return;
          }
          resolveClose();
        });
      })
  };
}
