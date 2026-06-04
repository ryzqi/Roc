import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAppServices, type AppServices } from '../../src/main/services/app-service';

let root: string;
let workspaceRoot: string;
let services: AppServices;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-file-perf-'));
  workspaceRoot = join(root, 'workspace');
  mkdirSync(workspaceRoot, { recursive: true });
  services = createAppServices(root);
  services.appService.initialize();
  services.workspaceService.selectWorkspace(workspaceRoot);
});

afterEach(async () => {
  await services.appService.shutdown();
  rmSync(root, { recursive: true, force: true });
});

describe('FileService performance guardrails', () => {
  it('truncates text previews without returning the full file', () => {
    writeFileSync(join(workspaceRoot, 'large.txt'), 'a'.repeat(1024 * 1024), 'utf8');

    const preview = services.fileService.readPreview({ relativePath: 'large.txt', maxBytes: 128 });

    expect(preview).toMatchObject({
      relativePath: 'large.txt',
      kind: 'text',
      content: 'a'.repeat(128),
      truncated: true,
      sizeBytes: 1024 * 1024
    });
  });

  it('does not inline large image previews into IPC payloads', () => {
    writeFileSync(join(workspaceRoot, 'large.png'), Buffer.alloc(1024 * 1024, 1));

    const preview = services.fileService.readPreview({ relativePath: 'large.png', maxBytes: 128 });

    expect(preview).toMatchObject({
      relativePath: 'large.png',
      kind: 'binary',
      content: '',
      truncated: true,
      sizeBytes: 1024 * 1024,
      mediaType: 'image/png'
    });
  });

  it('keeps shared PDF previews out of the global preview contract payload', () => {
    const relativePath = 'docs/spec.pdf';
    const absolutePath = join(workspaceRoot, 'docs', 'spec.pdf');
    const pdfBytes = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF', 'utf8');
    mkdirSync(join(workspaceRoot, 'docs'), { recursive: true });
    writeFileSync(absolutePath, pdfBytes);

    const preview = services.fileService.readPreview({ relativePath, maxBytes: 16 });

    expect(preview).toMatchObject({
      relativePath,
      kind: 'binary',
      content: 'PDF 文件需要在文件工作台中预览。',
      truncated: false,
      sizeBytes: pdfBytes.byteLength,
      mediaType: 'application/pdf'
    });
    expect(preview.content).not.toContain('%PDF-1.7');
    expect('fileUrl' in preview).toBe(false);
  });

  it('builds a PDF preview resource URL that hides toolbar download and print actions', () => {
    const relativePath = 'docs/spec.pdf';
    const absolutePath = join(workspaceRoot, 'docs', 'spec.pdf');
    mkdirSync(join(workspaceRoot, 'docs'), { recursive: true });
    writeFileSync(absolutePath, Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF', 'utf8'));

    const preview = services.fileService.readPdfWorkbenchPreview({ relativePath });

    expect(preview.resourceUrl).toBe('roc-preview://workspace/pdf/docs%2Fspec.pdf#toolbar=0&navpanes=0&scrollbar=0');
  });

  it('truncates workspace search when the visited file guardrail is reached', () => {
    for (let index = 0; index < 2100; index += 1) {
      writeFileSync(join(workspaceRoot, `file-${String(index).padStart(4, '0')}.txt`), 'no match\n', 'utf8');
    }

    const search = services.fileService.search({ query: 'not-present', maxResults: 100 });

    expect(search.matches).toEqual([]);
    expect(search.truncated).toBe(true);
  });
});
