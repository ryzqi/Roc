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
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('Invalid preview URL', { status: 400 });
    }
    if (url.hostname === 'research') {
      const exported = /^\/exports\/([^/]+)\/([^/]+)\/([a-f0-9]{64})\.pdf$/u.exec(url.pathname);
      if (exported !== null) {
        try {
          return kernel.invokeCapability<unknown, Response>('research.export.source', { projectId: decodeURIComponent(exported[1]), exportId: decodeURIComponent(exported[2]),
            sha256: exported[3] }).catch(() => new Response('Preview unavailable', { status: 404 }));
        } catch { return new Response('Invalid path', { status: 400 }); }
      }
      const figure = /^\/figures\/([^/]+)\/([^/]+)\/(png|svg|pdf)\/([a-f0-9]{64})$/u.exec(url.pathname);
      if (figure !== null) {
        try {
          return kernel.invokeCapability<unknown, Response>('research.figure.source', { projectId: decodeURIComponent(figure[1]), figureId: decodeURIComponent(figure[2]),
            format: figure[3], sha256: figure[4] }).catch(() => new Response('Preview unavailable', { status: 404 }));
        } catch { return new Response('Invalid path', { status: 400 }); }
      }
      const experiment = /^\/experiments\/([^/]+)\/([^/]+)\/(input|output|log)\/([^/]+)\/([a-f0-9]{64})$/u.exec(url.pathname);
      if (experiment !== null) {
        try {
          return kernel.invokeCapability<unknown, Response>('research.experiment.source', { projectId: decodeURIComponent(experiment[1]), runId: decodeURIComponent(experiment[2]),
            area: experiment[3], path: decodeURIComponent(experiment[4]), sha256: experiment[5] }).catch(() => new Response('Preview unavailable', { status: 404 }));
        } catch { return new Response('Invalid path', { status: 400 }); }
      }
      const indexed = /^\/project-files\/([^/]+)\/([^/]+)\/([a-f0-9]{64})$/u.exec(url.pathname);
      if (indexed !== null) {
        try {
          return kernel.invokeCapability<{ projectId: string; fileId: string; sourceHash: string }, Response>('research.index.source', {
            projectId: decodeURIComponent(indexed[1]), fileId: decodeURIComponent(indexed[2]), sourceHash: indexed[3]
          }).catch(() => new Response('Preview unavailable', { status: 404 }));
        } catch { return new Response('Invalid path', { status: 400 }); }
      }
      const source = /^\/documents\/([^/]+)\/source\/([a-f0-9]{64})$/u.exec(url.pathname);
      const asset = /^\/documents\/([^/]+)\/parses\/([^/]+)\/([^/]+)\/([a-f0-9]{64})\.png$/u.exec(url.pathname);
      try {
        if (source !== null) return kernel.invokeCapability<{ documentId: string; sourceHash: string }, Response>('research.document.source', { documentId: decodeURIComponent(source[1]), sourceHash: source[2] })
          .catch(() => new Response('Preview unavailable', { status: 404 }));
        if (asset !== null) return kernel.invokeCapability<{ documentId: string; parseId: string; assetId: string; sha256: string }, Response>('research.document.asset', { documentId: decodeURIComponent(asset[1]), parseId: decodeURIComponent(asset[2]),
          assetId: decodeURIComponent(asset[3]), sha256: asset[4] }).catch(() => new Response('Preview unavailable', { status: 404 }));
      } catch { return new Response('Invalid path', { status: 400 }); }
      const match = /^\/templates\/([^/]+)\/([^/]+)\/([a-f0-9]{64})\.pdf$/u.exec(url.pathname);
      if (match === null) return new Response('Not found', { status: 404 });
      let projectId: string;
      let templateId: string;
      try { projectId = decodeURIComponent(match[1]); templateId = decodeURIComponent(match[2]); }
      catch { return new Response('Invalid path', { status: 400 }); }
      return kernel.invokeCapability<{ projectId: string; templateId: string; pdfHash: string }, Response>('research.template.preview', { projectId, templateId, pdfHash: match[3] })
        .catch(() => new Response('Preview unavailable', { status: 404 }));
    }
    if (url.hostname !== 'workspace' || !url.pathname.startsWith('/pdf/')) {
      return new Response('Not found', { status: 404 });
    }
    const relativePath = url.pathname.slice('/pdf/'.length);
    return kernel.invokeCapability<{ relativePath: string }, Response>('files.streamPdfPreviewResource', { relativePath });
  });
}
