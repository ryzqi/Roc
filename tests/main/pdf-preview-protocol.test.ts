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

  it('requests a research PDF by project, template and content hash', async () => {
    const invokeCapability = vi.fn().mockResolvedValue(new Response('research-pdf'));
    const handler = captureHandler(() => ({ invokeCapability } as unknown as MainKernelBootstrap));
    const hash = 'a'.repeat(64);
    const response = await handler(new Request(`roc-preview://research/templates/project-1/template-1/${hash}.pdf`));
    expect(invokeCapability).toHaveBeenCalledWith('research.template.preview', { projectId: 'project-1', templateId: 'template-1', pdfHash: hash });
    expect(await response.text()).toBe('research-pdf');
  });

  it('rejects arbitrary research file paths and conceals failed preview details', async () => {
    const invokeCapability = vi.fn().mockRejectedValue(new Error('private path details'));
    const handler = captureHandler(() => ({ invokeCapability } as unknown as MainKernelBootstrap));
    expect((await handler(new Request('roc-preview://research/files/private.txt'))).status).toBe(404);
    expect(invokeCapability).not.toHaveBeenCalled();
    const response = await handler(new Request(`roc-preview://research/templates/project/template/${'b'.repeat(64)}.pdf`));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Preview unavailable');
  });

  it('routes document sources and versioned assets using identifiers and content hashes', async () => {
    const invokeCapability = vi.fn().mockImplementation(async () => new Response('resource'));
    const handler = captureHandler(() => ({ invokeCapability } as unknown as MainKernelBootstrap));
    const hash = 'c'.repeat(64);
    expect((await handler(new Request(`roc-preview://research/documents/document%201/source/${hash}`))).status).toBe(200);
    expect(invokeCapability).toHaveBeenLastCalledWith('research.document.source', { documentId: 'document 1', sourceHash: hash });
    expect((await handler(new Request(`roc-preview://research/documents/document%201/parses/parse%202/asset_0/${hash}.png`))).status).toBe(200);
    expect(invokeCapability).toHaveBeenLastCalledWith('research.document.asset', { documentId: 'document 1', parseId: 'parse 2', assetId: 'asset_0', sha256: hash });
  });

  it('routes indexed source versions by project, file identity and hash', async () => {
    const invokeCapability = vi.fn().mockResolvedValue(new Response('source'));
    const handler = captureHandler(() => ({ invokeCapability } as unknown as MainKernelBootstrap));
    const hash = 'e'.repeat(64);
    expect((await handler(new Request(`roc-preview://research/project-files/project%201/file%202/${hash}`))).status).toBe(200);
    expect(invokeCapability).toHaveBeenCalledWith('research.index.source', { projectId: 'project 1', fileId: 'file 2', sourceHash: hash });
    expect((await handler(new Request(`roc-preview://research/project-files/%ZZ/file/${hash}`))).status).toBe(400);
  });

  it('routes experiment outputs with their content hash and keeps directory paths encoded', async () => {
    const invokeCapability = vi.fn().mockResolvedValue(new Response('experiment-output'));
    const handler = captureHandler(() => ({ invokeCapability } as unknown as MainKernelBootstrap));
    const hash = 'f'.repeat(64);
    const response = await handler(new Request(`roc-preview://research/experiments/project%201/run%202/output/plots%2Fresult%20one.pdf/${hash}`));
    expect(await response.text()).toBe('experiment-output');
    expect(invokeCapability).toHaveBeenCalledWith('research.experiment.source', { projectId: 'project 1', runId: 'run 2', area: 'output', path: 'plots/result one.pdf', sha256: hash });
    expect((await handler(new Request(`roc-preview://research/experiments/project/run/output/%ZZ/${hash}`))).status).toBe(400);
    expect((await handler(new Request(`roc-preview://research/experiments/project/run/scratch/private/${hash}`))).status).toBe(404);
  });

  it('conceals unavailable experiment resource paths', async () => {
    const invokeCapability = vi.fn().mockRejectedValue(new Error('private experiment path'));
    const handler = captureHandler(() => ({ invokeCapability } as unknown as MainKernelBootstrap));
    const response = await handler(new Request(`roc-preview://research/experiments/project/run/output/result.pdf/${'a'.repeat(64)}`));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Preview unavailable');
  });

  it('rejects malformed document routes and conceals unavailable source details', async () => {
    const invokeCapability = vi.fn().mockRejectedValue(new Error('private document path'));
    const handler = captureHandler(() => ({ invokeCapability } as unknown as MainKernelBootstrap));
    const hash = 'd'.repeat(64);
    expect((await handler(new Request(`roc-preview://research/documents/%ZZ/source/${hash}`))).status).toBe(400);
    expect((await handler(new Request('roc-preview://research/documents/document/source/private.pdf'))).status).toBe(404);
    expect(invokeCapability).not.toHaveBeenCalled();
    const response = await handler(new Request(`roc-preview://research/documents/document/source/${hash}`));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Preview unavailable');
  });

  function captureHandler(getKernel: () => MainKernelBootstrap | null): ProtocolHandler {
    registerPdfPreviewProtocol(getKernel);
    expect(handle).toHaveBeenCalledTimes(1);
    const [scheme, handler] = handle.mock.calls[0] as [string, ProtocolHandler];
    expect(scheme).toBe('roc-preview');
    return handler;
  }
});
