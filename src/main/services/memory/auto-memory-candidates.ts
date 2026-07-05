import type {
  AppSettings,
  AutoMemoryCandidateType,
  AutoMemoryConfidence,
  MemoryScope
} from '../../../shared/types';
import type { AgentRunCompletedPayload } from './auto-memory-writer';

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

const candidateTypes = new Set<AutoMemoryCandidateType>([
  'user_preference',
  'workspace_fact',
  'decision',
  'pitfall',
  'verification',
  'transient_task_result'
]);

const confidences = new Set<AutoMemoryConfidence>(['high', 'medium', 'low']);

export function extractAutoMemoryCandidates(
  payload: AgentRunCompletedPayload,
  settings: AppSettings['memory']['autoMemory'],
  createdAt: string
): AutoMemoryCandidate[] {
  const candidates: AutoMemoryCandidate[] = [];
  const lines = payload.summary.split('\n');
  for (const line of lines) {
    if (candidates.length >= settings.maxCandidatesPerRun) {
      break;
    }
    const candidate = parseCandidateLine(line, payload, settings, createdAt);
    if (candidate !== null) {
      candidates.push(candidate);
    }
  }
  return candidates;
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
  const nextHeadingIndex = findNextDateHeading(lines, headingIndex + 1);
  const insertIndex = nextHeadingIndex === -1 ? lines.length : nextHeadingIndex;
  const before = lines.slice(0, insertIndex);
  const after = lines.slice(insertIndex);
  before.push(entry);
  return [...before, ...after].join('\n');
}

function parseCandidateLine(
  line: string,
  payload: AgentRunCompletedPayload,
  settings: AppSettings['memory']['autoMemory'],
  createdAt: string
): AutoMemoryCandidate | null {
  const match = /^([a-z_]+):\s*(.*)$/u.exec(line.trim());
  if (match === null) {
    return null;
  }
  const rawType = match[1];
  if (!isCandidateType(rawType)) {
    return null;
  }
  const body = match[2];
  if (body === undefined) {
    return null;
  }
  const parts = body.split('|').map((part) => part.trim());
  if (parts.length < 4) {
    return null;
  }
  const key = parts[0];
  const rawConfidence = parts[1];
  const evidence = parts[2] === undefined ? [] : parts[2].split(',').map((item) => item.trim()).filter((item) => item.length > 0);
  const summary = parts[3];
  if (key === undefined || rawConfidence === undefined || summary === undefined || !isConfidence(rawConfidence)) {
    return null;
  }
  const metadata = parseMetadata(parts.slice(4), settings);
  return {
    type: rawType,
    scope: resolveCandidateScope(rawType, payload.workspacePath),
    confidence: rawConfidence,
    key,
    summary,
    evidence,
    sourceRunId: payload.runId,
    sourceThreadId: payload.threadId,
    workspacePath: payload.workspacePath === undefined ? null : payload.workspacePath,
    createdAt,
    ttlDays: metadata.ttlDays,
    revalidate: metadata.revalidate
  };
}

function parseMetadata(parts: string[], settings: AppSettings['memory']['autoMemory']): { ttlDays: number | null; revalidate: string | null } {
  let ttlDays: number | null = null;
  let revalidate: string | null = null;
  for (const part of parts) {
    const revalidatePrefix = 'revalidate=';
    const ttlPrefix = 'ttlDays=';
    if (part.startsWith(revalidatePrefix)) {
      const value = part.slice(revalidatePrefix.length).trim();
      revalidate = value.length === 0 ? null : value;
      continue;
    }
    if (part.startsWith(ttlPrefix)) {
      const parsed = Number.parseInt(part.slice(ttlPrefix.length).trim(), 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        ttlDays = parsed;
      }
    }
  }
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

function isCandidateType(value: string): value is AutoMemoryCandidateType {
  return candidateTypes.has(value as AutoMemoryCandidateType);
}

function isConfidence(value: string): value is AutoMemoryConfidence {
  return confidences.has(value as AutoMemoryConfidence);
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

function parseUserPreferenceEntries(existing: string): Array<{ key: string; summary: string }> {
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
  return value.replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
}

function findNextDateHeading(lines: string[], start: number): number {
  for (let index = start; index < lines.length; index += 1) {
    if (/^## \d{4}-\d{2}-\d{2}$/u.test(lines[index])) {
      return index;
    }
  }
  return -1;
}

function findNextSecondLevelHeading(lines: string[], start: number): number {
  for (let index = start; index < lines.length; index += 1) {
    if (/^##\s+\S/u.test(lines[index])) {
      return index;
    }
  }
  return -1;
}
