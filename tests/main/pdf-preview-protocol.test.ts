import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MainKernelBootstrap } from '../../src/main/main-kernel-bootstrap';

const registerSchemesAsPrivileged = vi.fn();
const handle = vi.fn();

vi.mock('electron', () => ({
  protocol: {
    registerSchemesAsPrivileged: (...args: unknown[]) => registerSchemesAsPrivileged(...args),
    handle: (...args: unknown[]) => handle(...args)
  }
}));

const { registerPdfPreviewProtocol, registerPdfPreviewScheme } = await import('../../src/main/pdf-preview-protocol');

type ProtocolHandler = (request: Request) => Response | Promise<Response>;

describe('pdf preview protocol', () => {
  beforeEach(() => {
    registerSchemesAsPrivileged.mockClear();
    handle.mockClear();
  });

  it('registers the preview scheme as a privileged standard stream scheme', () => {
    registerPdfPreviewScheme();

    expect(registerSchemesAsPrivileged).toHaveBeenCalledWith([
      {
        scheme: 'roc-preview',
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          stream: true
        }
      }
    ]);
  });

  it('answers 503 while the kernel has not booted yet', async () => {
    const handler = captureHandler(() => null);

    const response = await handler(new Request('roc-preview://workspace/pdf/docs/spec.pdf'));

    expect(response.status).toBe(503);
    expect(await response.text()).toBe('Preview service unavailable');
  });

  it('delegates the decoded relative path to the files capability', async () => {
    const invokeCapability = vi.fn().mockResolvedValue(new Response('pdf-bytes', { status: 200 }));
    const handler = captureHandler(() => ({ invokeCapability } as unknown as MainKernelBootstrap));

    const response = await handler(new Request('roc-preview://workspace/pdf/docs/spec.pdf'));

    expect(invokeCapability).toHaveBeenCalledWith('files.streamPdfPreviewResource', { relativePath: 'docs/spec.pdf' });
    expect(await response.text()).toBe('pdf-bytes');
  });

  it('rejects a foreign host instead of forwarding it to the workspace capability', async () => {
    const invokeCapability = vi.fn();
    const handler = captureHandler(() => ({ invokeCapability } as unknown as MainKernelBootstrap));

    const response = await handler(new Request('roc-preview://attacker/pdf/docs/spec.pdf'));

    expect(response.status).toBe(404);
    expect(invokeCapability).not.toHaveBeenCalled();
  });

  it('rejects a path outside the pdf prefix instead of forwarding it', async () => {
    const invokeCapability = vi.fn();
    const handler = captureHandler(() => ({ invokeCapability } as unknown as MainKernelBootstrap));

    const response = await handler(new Request('roc-preview://workspace/secrets/.env'));

    expect(response.status).toBe(404);
    expect(invokeCapability).not.toHaveBeenCalled();
  });

  function captureHandler(getKernel: () => MainKernelBootstrap | null): ProtocolHandler {
    registerPdfPreviewProtocol(getKernel);
    expect(handle).toHaveBeenCalledTimes(1);
    const [scheme, handler] = handle.mock.calls[0] as [string, ProtocolHandler];
    expect(scheme).toBe('roc-preview');
    return handler;
  }
});
