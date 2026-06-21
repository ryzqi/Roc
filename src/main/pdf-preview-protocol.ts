import { protocol } from 'electron';

import type { MainKernelBootstrap } from './main-kernel-bootstrap';

const pdfPreviewScheme = 'roc-preview';

export function registerPdfPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: pdfPreviewScheme,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true
      }
    }
  ]);
}

export function registerPdfPreviewProtocol(getKernel: () => MainKernelBootstrap | null): void {
  protocol.handle(pdfPreviewScheme, (request) => {
    const kernel = getKernel();
    if (kernel === null) {
      return new Response('Preview service unavailable', { status: 503 });
    }
    const url = new URL(request.url);
    if (url.hostname !== 'workspace' || !url.pathname.startsWith('/pdf/')) {
      return new Response('Not found', { status: 404 });
    }
    const relativePath = url.pathname.slice('/pdf/'.length);
    return kernel.invokeCapability<{ relativePath: string }, Response>('files.streamPdfPreviewResource', { relativePath });
  });
}
