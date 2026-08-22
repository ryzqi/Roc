import type {
  AppSettings,
  AutoMemoryCandidateType,
  AutoMemoryConfidence,
  MemoryScope
} from '../../../shared/types';

/** 单条记忆的字段上限,保证一条条目远小于记忆文件的字符上限,不会靠归档腾地方也写不进去。 */
const MAX_KEY_CHARS = 120;
const MAX_SUMMARY_CHARS = 400;
const MAX_EVIDENCE_CHARS = 400;

export type AutoMemoryCandidate = {
  type: AutoMemoryCandidateType;
  scope: MemoryScope;
  confidence: AutoMemoryConfidence;
  key: string;
  summary: string;
  evidence: string[];
  sourceRunId: string;
  sourceThreadId: string | null;
  workspacePath: string | null;
  createdAt: string;
  ttlDays: number | null;
  revalidate: string | null;
};

export type AutoMemoryCandidateInput = {
  type: AutoMemoryCandidateType;
  confidence: AutoMemoryConfidence;
  key: string;
  summary: string;
  evidence: readonly string[];
  sourceRunId: string;
  sourceThreadId: string | null;
  workspacePath: string | null | undefined;
  ttlDays: number | null;
  revalidate: string | null;
};

/** 已经落盘的结构化条目，用于 TTL 清理、归档搬迁和 memory_search。 */
export type ParsedAutoMemoryEntry = {
  type: string;
  key: string;
  confidence: string;
  source: string;
  evidence: string[];
  summary: string;
  ttlDays: number | null;
  revalidate: string | null;
  sectionDate: string | null;
  startLine: number;
  endLine: number;
};

export function buildAutoMemoryCandidate(
  input: AutoMemoryCandidateInput,
  settings: AppSettings['memory']['autoMemory'],
  createdAt: string
): AutoMemoryCandidate {
  const metadata = normalizeCandidateMetadata(input, settings);
  return {
    type: input.type,
    scope: resolveCandidateScope(input.type, input.workspacePath),
    confidence: input.confidence,
    key: collapseWhitespace(input.key),
    summary: collapseWhitespace(input.summary),
    evidence: input.evidence.map((item) => collapseWhitespace(item)).filter((item) => item.length > 0),
    sourceRunId: input.sourceRunId,
    sourceThreadId: input.sourceThreadId,
    workspacePath: input.workspacePath === undefined ? null : input.workspacePath,
    createdAt,
    ttlDays: metadata.ttlDays,
    revalidate: metadata.revalidate
  };
}

export function shouldRejectCandidate(candidate: AutoMemoryCandidate): string | null {
  if (candidate.summary.length === 0) {
    return 'summary_empty';
  }
  if (candidate.key.length === 0) {
    return 'key_empty';
  }
  if (candidate.sourceRunId.length === 0) {
    return 'source_run_id_empty';
  }
  if ([...candidate.summary].length > MAX_SUMMARY_CHARS) {
    return 'summary_too_long';
  }
  if ([...candidate.key].length > MAX_KEY_CHARS) {
    return 'key_too_long';
  }
  if ([...candidate.evidence.join(', ')].length > MAX_EVIDENCE_CHARS) {
    return 'evidence_too_long';
  }
  if (candidate.type === 'transient_task_result') {
    return 'transient_task_result';
  }
  if (candidate.type === 'user_preference' && candidate.confidence !== 'high') {
    return 'user_preference_high_confidence_required';
  }
  if (candidate.type === 'user_preference' && !isSafeUserPreferenceKey(candidate.key)) {
    return 'user_preference_key_unsafe';
  }
  if (candidate.type === 'user_preference' && candidate.evidence.length === 0) {
    return 'user_preference_evidence_required';
  }
  if (candidate.type === 'user_preference' && !hasDirectUserEvidence(candidate.evidence)) {
    return 'user_preference_direct_user_evidence_required';
  }
  if (candidate.type === 'workspace_fact' && candidate.evidence.length === 0) {
    return 'workspace_fact_evidence_required';
  }
  if (candidate.type === 'pitfall' && candidate.evidence.length === 0) {
    return 'pitfall_evidence_required';
  }
  if (candidate.type === 'pitfall' && candidate.confidence === 'low' && candidate.ttlDays === null && candidate.revalidate === null) {
    return 'low_confidence_pitfall_requires_ttl_or_revalidate';
  }
  if (candidate.type === 'verification' && candidate.evidence.length === 0) {
    return 'verification_evidence_required';
  }
  return null;
}

export function autoMemoryEntryExists(existing: string, candidate: AutoMemoryCandidate): boolean {
  const normalizedSummary = normalizeMemoryText(candidate.summary);
  const lines = existing.split('\n');
  let sawKey = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === `key: ${candidate.key}`) {
      sawKey = true;
      continue;
    }
    if (sawKey && trimmed.startsWith('summary: ')) {
      return normalizeMemoryText(trimmed.slice('summary: '.length)) === normalizedSummary;
    }
    if (trimmed.startsWith('- type: ')) {
      sawKey = false;
    }
  }
  return false;
}

export function formatUserPreferenceEntry(candidate: AutoMemoryCandidate): string {
  return [`<!-- key: ${candidate.key} -->`, `- ${candidate.summary}`].join('\n');
}

export function appendUserPreferenceEntry(existing: string, entry: string): string {
  const trimmed = existing.trimEnd();
  const heading = '## Preferences';
  if (trimmed.length === 0) {
    return [heading, '', entry].join('\n');
  }
  const lines = trimmed.split('\n');
  const headingIndex = lines.findIndex((line) => line.trim() === heading);
  if (headingIndex === -1) {
    return [trimmed, '', heading, '', entry].join('\n');
  }
  const nextHeadingIndex = findNextSecondLevelHeading(lines, headingIndex + 1);
  const insertIndex = nextHeadingIndex === -1 ? lines.length : nextHeadingIndex;
  const before = lines.slice(0, insertIndex);
  while (before.length > 0 && before[before.length - 1].trim().length === 0) {
    before.pop();
  }
  const after = lines.slice(insertIndex);
  if (after.length === 0) {
    return [...before, '', entry].join('\n');
  }
  return [...before, '', entry, '', ...after].join('\n');
}

export function userPreferenceEntryStatus(
  existing: string,
  candidate: AutoMemoryCandidate
): 'duplicate' | 'conflict' | null {
  const entries = parseUserPreferenceEntries(existing);
  const existingEntry = entries.find((entry) => entry.key === candidate.key);
  if (existingEntry === undefined) {
    return null;
  }
  if (normalizeMemoryText(existingEntry.summary) === normalizeMemoryText(candidate.summary)) {
    return 'duplicate';
  }
  return 'conflict';
}

export function formatAutoMemoryEntry(candidate: AutoMemoryCandidate): string {
  const lines = [
    `- type: ${candidate.type}`,
    `  key: ${candidate.key}`,
    `  confidence: ${candidate.confidence}`,
    `  source: ${candidate.sourceRunId}`,
    `  evidence: ${candidate.evidence.join(', ')}`,
    `  summary: ${candidate.summary}`
  ];
  if (candidate.ttlDays !== null) {
    lines.push(`  ttlDays: ${candidate.ttlDays}`);
  }
  if (candidate.revalidate !== null) {
    lines.push(`  revalidate: ${candidate.revalidate}`);
  }
  return lines.join('\n');
}

export function appendAutoMemoryEntry(existing: string, date: string, entry: string): string {
  const trimmed = existing.trimEnd();
  const heading = `## ${date}`;
  if (trimmed.length === 0) {
    return [heading, '', entry].join('\n');
  }
  const lines = trimmed.split('\n');
  const headingIndex = lines.findIndex((line) => line.trim() === heading);
  if (headingIndex === -1) {
    return [trimmed, '', heading, '', entry].join('\n');
  }
  const nextHeadingIndex = findNextSecondLevelHeading(lines, headingIndex + 1);
  const insertIndex = nextHeadingIndex === -1 ? lines.length : nextHeadingIndex;
  const before = lines.slice(0, insertIndex);
  while (before.length > 0 && before[before.length - 1].trim().length === 0) {
    before.pop();
  }
  const after = lines.slice(insertIndex);
  before.push(entry);
  if (after.length > 0) {
    before.push('');
  }
  return [...before, ...after].join('\n');
}

/**
 * 用新的 summary 覆盖同一个 key 的偏好条目（supersede）。
 * 旧值不会丢失：调用方把 previousSummary 写进 memory_auto_audit。
 */
export function replaceUserPreferenceEntry(
  existing: string,
  candidate: AutoMemoryCandidate
): { content: string; previousSummary: string } | null {
  const lines = existing.split('\n');
  let pendingKey: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    const keyMatch = /^<!--\s*key:\s*([a-z0-9._:-]+)\s*-->$/u.exec(trimmed);
    if (keyMatch !== null) {
      pendingKey = keyMatch[1];
      continue;
    }
    if (pendingKey === null || !trimmed.startsWith('- ')) {
      continue;
    }
    if (pendingKey === candidate.key) {
      const previousSummary = trimmed.slice(2).trim();
      const next = [...lines];
      next[index] = `- ${candidate.summary}`;
      return { content: next.join('\n'), previousSummary };
    }
    pendingKey = null;
  }
  return null;
}

export function parseAutoMemoryEntries(content: string): ParsedAutoMemoryEntry[] {
  const lines = content.split('\n');
  const entries: ParsedAutoMemoryEntry[] = [];
  let sectionDate: string | null = null;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const dateMatch = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/u.exec(line);
    if (dateMatch !== null) {
      sectionDate = dateMatch[1];
      index += 1;
      continue;
    }
    if (/^##\s+\S/u.test(line)) {
      sectionDate = null;
      index += 1;
      continue;
    }
    const typeMatch = /^-\s+type:\s*(\S+)\s*$/u.exec(line);
    if (typeMatch === null) {
      index += 1;
      continue;
    }
    const startLine = index;
    const fields = new Map<string, string>();
    index += 1;
    while (index < lines.length && /^\s+\S/u.test(lines[index])) {
      const fieldMatch = /^\s+([A-Za-z]+):\s*(.*)$/u.exec(lines[index]);
      if (fieldMatch !== null) {
        fields.set(fieldMatch[1], fieldMatch[2].trim());
      }
      index += 1;
    }
    const ttlRaw = fields.get('ttlDays');
    const parsedTtl = ttlRaw === undefined ? Number.NaN : Number.parseInt(ttlRaw, 10);
    const evidenceRaw = fields.get('evidence') ?? '';
    entries.push({
      type: typeMatch[1],
      key: fields.get('key') ?? '',
      confidence: fields.get('confidence') ?? '',
      source: fields.get('source') ?? '',
      evidence: evidenceRaw
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
      summary: fields.get('summary') ?? '',
      ttlDays: Number.isInteger(parsedTtl) && parsedTtl > 0 ? parsedTtl : null,
      revalidate: fields.get('revalidate') ?? null,
      sectionDate,
      startLine,
      endLine: index
    });
  }
  return entries;
}

/** 删除 ttlDays 已过期的结构化条目，并清掉因此变空的日期小节。 */
export function pruneExpiredAutoMemoryEntries(
  content: string,
  today: string
): { content: string; removed: ParsedAutoMemoryEntry[] } {
  const expired = parseAutoMemoryEntries(content).filter((entry) => isEntryExpired(entry, today));
  if (expired.length === 0) {
    return { content, removed: [] };
  }
  const dropped = new Set<number>();
  for (const entry of expired) {
    for (let line = entry.startLine; line < entry.endLine; line += 1) {
      dropped.add(line);
    }
  }
  const kept = content.split('\n').filter((_line, index) => !dropped.has(index));
  return { content: dropEmptyDateSections(kept).join('\n').trimEnd(), removed: expired };
}

/**
 * 取出最旧的日期小节用于归档。只剩一个日期小节时返回 null：
 * 最近一次的记忆必须留在 MEMORY.md 里，否则索引层会被搬空。
 */
export function extractOldestAutoMemorySection(
  content: string
): { sectionDate: string; section: string; remaining: string } | null {
  const lines = content.split('\n');
  const sections: Array<{ date: string; start: number; end: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const dateMatch = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/u.exec(lines[index]);
    if (dateMatch === null) {
      continue;
    }
    sections.push({ date: dateMatch[1], start: index, end: findNextSecondLevelHeading(lines, index + 1) });
  }
  if (sections.length < 2) {
    return null;
  }
  const oldest = sections.reduce((left, right) => (right.date < left.date ? right : left));
  const end = oldest.end === -1 ? lines.length : oldest.end;
  const section = lines.slice(oldest.start, end).join('\n').trimEnd();
  const remaining = [...lines.slice(0, oldest.start), ...lines.slice(end)].join('\n').trimEnd();
  return { sectionDate: oldest.date, section, remaining };
}

export function archiveTopicSlug(sectionDate: string): string {
  return `archive-${sectionDate.slice(0, 7)}`;
}

/** 在 MEMORY.md 保留一行索引，指向搬走的归档主题文件。 */
export function appendArchiveIndexLine(
  content: string,
  input: { sectionDate: string; topicPath: string }
): string {
  const line = `- ${input.sectionDate.slice(0, 7)}: ${input.topicPath}`;
  const heading = '## Archive';
  const trimmed = content.trimEnd();
  if (trimmed.split('\n').some((existing) => existing.trim() === line)) {
    return trimmed;
  }
  const lines = trimmed.split('\n');
  const headingIndex = lines.findIndex((existing) => existing.trim() === heading);
  if (headingIndex === -1) {
    if (trimmed.length === 0) {
      return [heading, '', line].join('\n');
    }
    return [trimmed, '', heading, '', line].join('\n');
  }
  const nextHeadingIndex = findNextSecondLevelHeading(lines, headingIndex + 1);
  const insertIndex = nextHeadingIndex === -1 ? lines.length : nextHeadingIndex;
  const before = lines.slice(0, insertIndex);
  while (before.length > 0 && before[before.length - 1].trim().length === 0) {
    before.pop();
  }
  const after = lines.slice(insertIndex);
  if (after.length === 0) {
    return [...before, line].join('\n');
  }
  return [...before, line, '', ...after].join('\n');
}

export function appendTopicArchiveSection(topicContent: string, section: string): string {
  const trimmedTopic = topicContent.trimEnd();
  if (trimmedTopic.length === 0) {
    return ['# Archived memory entries', '', section].join('\n');
  }
  if (trimmedTopic.includes(section)) {
    return trimmedTopic;
  }
  return [trimmedTopic, '', section].join('\n');
}

function isEntryExpired(entry: ParsedAutoMemoryEntry, today: string): boolean {
  if (entry.ttlDays === null || entry.sectionDate === null) {
    return false;
  }
  const created = new Date(`${entry.sectionDate}T00:00:00.000Z`);
  if (Number.isNaN(created.getTime())) {
    return false;
  }
  created.setUTCDate(created.getUTCDate() + entry.ttlDays);
  return created.toISOString().slice(0, 10) < today;
}

function dropEmptyDateSections(lines: string[]): string[] {
  const result: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const dateMatch = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/u.exec(lines[index]);
    if (dateMatch === null) {
      result.push(lines[index]);
      index += 1;
      continue;
    }
    const end = findNextSecondLevelHeading(lines, index + 1);
    const sectionEnd = end === -1 ? lines.length : end;
    const body = lines.slice(index + 1, sectionEnd);
    if (body.every((line) => line.trim().length === 0)) {
      index = sectionEnd;
      continue;
    }
    result.push(...lines.slice(index, sectionEnd));
    index = sectionEnd;
  }
  return result;
}

function normalizeCandidateMetadata(
  input: AutoMemoryCandidateInput,
  settings: AppSettings['memory']['autoMemory']
): { ttlDays: number | null; revalidate: string | null } {
  const revalidate =
    input.revalidate === null || collapseWhitespace(input.revalidate).length === 0
      ? null
      : collapseWhitespace(input.revalidate);
  let ttlDays =
    input.ttlDays !== null && Number.isInteger(input.ttlDays) && input.ttlDays > 0 ? input.ttlDays : null;
  if (ttlDays === null && revalidate !== null) {
    ttlDays = settings.lowConfidenceTtlDays;
  }
  return { ttlDays, revalidate };
}

function resolveCandidateScope(type: AutoMemoryCandidateType, workspacePath: string | null | undefined): MemoryScope {
  if (type === 'workspace_fact' || type === 'pitfall' || type === 'verification') {
    return 'workspace';
  }
  if (type === 'decision' && workspacePath !== undefined && workspacePath !== null) {
    return 'workspace';
  }
  return 'global';
}

function hasDirectUserEvidence(evidence: string[]): boolean {
  return evidence.some((item) => {
    const normalized = normalizeMemoryText(item);
    return (
      normalized.startsWith('user stated') ||
      normalized.startsWith('user confirmed') ||
      normalized.startsWith('user selected') ||
      normalized.startsWith('user chose') ||
      normalized.startsWith('user requested') ||
      normalized.startsWith('user asked')
    );
  });
}

export function parseUserPreferenceEntries(existing: string): Array<{ key: string; summary: string }> {
  const entries: Array<{ key: string; summary: string }> = [];
  const lines = existing.split('\n');
  let pendingKey: string | null = null;
  for (const line of lines) {
    const keyMatch = /^<!--\s*key:\s*([a-z0-9._:-]+)\s*-->\s*$/u.exec(line.trim());
    if (keyMatch !== null) {
      pendingKey = keyMatch[1];
      continue;
    }
    if (pendingKey !== null && line.trim().startsWith('- ')) {
      entries.push({ key: pendingKey, summary: line.trim().slice(2).trim() });
      pendingKey = null;
    }
  }
  return entries;
}

function isSafeUserPreferenceKey(key: string): boolean {
  return /^[a-z0-9._:-]+$/u.test(key);
}

function normalizeMemoryText(value: string): string {
  return collapseWhitespace(value).toLocaleLowerCase();
}

/**
 * 记忆文件是按行解析的,所以模型给的字段必须压成单行,
 * 否则一个带换行的 summary 就能在 MEMORY.md 里伪造出额外条目或日期小节。
 */
function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function findNextSecondLevelHeading(lines: string[], start: number): number {
  for (let index = start; index < lines.length; index += 1) {
    if (/^##\s+\S/u.test(lines[index])) {
      return index;
    }
  }
  return -1;
}
