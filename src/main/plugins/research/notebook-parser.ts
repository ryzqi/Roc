import { createHash } from 'node:crypto';
import {
  notebookLimits, researchNotebookSchema, researchNotebookPreviewSchema,
  type ResearchNotebook, type ResearchNotebookCell, type ResearchNotebookPreview, type ResearchNotebookReviewIssue
} from '../../../shared/schemas/research-notebooks';

function hash(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function text(value: string | string[]): string { return typeof value === 'string' ? value : value.join(''); }

function checkStructure(value: unknown): void {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length !== 0) {
    const item = pending.pop()!;
    if (++nodes > notebookLimits.nodes) throw new Error('research_notebook_node_limit');
    if (item.depth > notebookLimits.depth) throw new Error('research_notebook_depth_limit');
    if (item.value !== null && typeof item.value === 'object') {
      for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 });
    }
  }
}

function reviewSource(cell: ResearchNotebookCell, source: string): ResearchNotebookReviewIssue[] {
  if (cell.cell_type !== 'code') return [];
  const issues: ResearchNotebookReviewIssue[] = [];
  for (const [index, line] of source.split('\n').entries()) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('%') || /\bget_ipython\s*\(/u.test(line)) {
      issues.push({ kind: 'magic', line: index + 1, detail: 'IPython-specific syntax requires review.' });
    }
    if (trimmed.startsWith('!') || /\b(?:subprocess|os\.system)\b/u.test(line)) {
      issues.push({ kind: 'shell', line: index + 1, detail: 'Shell or subprocess syntax requires review.' });
    }
    if (/["'](?:\/|~\/|[a-zA-Z]:[\\/]|(?:\.\.[\\/])+)[^"']*["']/u.test(line)) {
      issues.push({ kind: 'external_path', line: index + 1, detail: 'A path literal may refer outside declared inputs.' });
    }
    if (/^\s*%(?:load_ext|reload_ext|unload_ext)\b/u.test(line)) {
      issues.push({ kind: 'extension', line: index + 1, detail: 'Notebook extensions have no supported execution contract.' });
    }
    if (issues.length > notebookLimits.reviewIssuesPerCell) throw new Error('research_notebook_review_limit');
  }
  return issues;
}

function previewCell(cell: ResearchNotebookCell, index: number): ResearchNotebookPreview['cells'][number] {
  const source = text(cell.source);
  if (Buffer.byteLength(source) > notebookLimits.sourceBytes) throw new Error('research_notebook_source_limit');
  const reviewIssues = reviewSource(cell, source);
  const outputs = cell.cell_type === 'code' ? cell.outputs.map((output, outputIndex) => {
    const serialized = JSON.stringify(output);
    if (Buffer.byteLength(serialized) > notebookLimits.outputBytes) throw new Error('research_notebook_output_limit');
    let literal: string;
    let mimeTypes: string[];
    if (output.output_type === 'stream') { literal = text(output.text); mimeTypes = ['text/plain']; }
    else if (output.output_type === 'error') {
      literal = `${output.ename}: ${output.evalue}\n${output.traceback.join('\n')}`; mimeTypes = ['text/plain'];
    } else {
      mimeTypes = Object.keys(output.data);
      const plain = output.data['text/plain'];
      literal = plain === undefined ? '' : text(plain as string | string[]);
      for (const mime of mimeTypes.filter(mime => mime !== 'text/plain')) {
        reviewIssues.push({ kind: 'rich_output', line: null, detail: `Output ${outputIndex + 1}: ${mime} is retained without rendering.` });
        if (reviewIssues.length > notebookLimits.reviewIssuesPerCell) throw new Error('research_notebook_review_limit');
      }
    }
    return { index: outputIndex, kind: output.output_type, mimeTypes,
      text: literal.slice(0, notebookLimits.previewCharacters), textCharacters: literal.length,
      hash: hash(serialized), trust: 'untrusted' as const };
  }) : [];
  const attachments = cell.cell_type === 'code' ? [] : Object.entries(cell.attachments ?? {}).map(([name, bundle]) => ({
    name, hash: hash(JSON.stringify(bundle)), mimeTypes: Object.keys(bundle)
  }));
  return { id: cell.id, index, cellType: cell.cell_type, sourceHash: hash(source), cellHash: hash(JSON.stringify(cell)),
    source: source.slice(0, notebookLimits.previewCharacters), sourceCharacters: source.length,
    executionCount: cell.cell_type === 'code' ? cell.execution_count : null, outputs, attachments, reviewIssues };
}

export function parseResearchNotebook(bytes: Uint8Array): { notebook: ResearchNotebook; preview: ResearchNotebookPreview } {
  if (bytes.byteLength > notebookLimits.bytes) throw new Error('research_notebook_size_limit');
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(decoded);
  checkStructure(value);
  researchNotebookSchema.parse(value);
  // Validation has no coercions or transforms. Retain the decoded original,
  // including field order, rather than hashing Zod's reconstructed objects.
  const notebook = value as ResearchNotebook;
  const ids = new Set<string>(), names = new Set<string>();
  for (const cell of notebook.cells) {
    if (ids.has(cell.id)) throw new Error('research_notebook_duplicate_cell_id');
    ids.add(cell.id);
    const name = cell.metadata.name;
    if (name !== undefined) {
      if (names.has(name)) throw new Error('research_notebook_duplicate_cell_name');
      names.add(name);
    }
  }
  return { notebook, preview: researchNotebookPreviewSchema.parse({
    schemaVersion: 1, format: 'nbformat-4.5', sha256: hash(bytes), size: bytes.byteLength,
    language: notebook.metadata.language_info?.name ?? null, kernel: notebook.metadata.kernelspec?.name ?? null,
    execution: 'static', outputTrust: 'untrusted', cells: notebook.cells.map(previewCell)
  }) };
}
