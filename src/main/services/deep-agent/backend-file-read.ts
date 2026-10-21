import { normalizeReadPagination, type ReadRawResult, type ReadResult } from 'deepagents';

export function readBackendSlice(raw: ReadRawResult, offset = 0, limit = 500): ReadResult {
  if (raw.error !== undefined) return { error: raw.error };
  const data = raw.data;
  if (data === undefined || !('mimeType' in data) || Array.isArray(data.content)) return { error: 'backend_file_format_unsupported' };
  if (typeof data.content !== 'string') return { content: data.content, mimeType: data.mimeType };
  const range = normalizeReadPagination(offset, limit);
  const lines = data.content.split('\n');
  const totalLines = lines.at(-1) === '' ? lines.length - 1 : lines.length;
  const selected = lines.slice(range.offset, range.offset + range.limit);
  const end = Math.min(range.offset + selected.length, totalLines);
  return { content: selected.join('\n'), mimeType: data.mimeType, totalLines,
    ...(range.offset < totalLines && range.limit > 0 ? { startLine: range.offset + 1, endLine: end } : {}),
    ...(end < totalLines ? { nextOffset: end } : {}) };
}
