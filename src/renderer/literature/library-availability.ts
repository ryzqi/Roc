import type {ResearchDocument, ResearchLibraryItem} from '../../shared/types';
import type {StatusBadgeTone} from '../shared/StatusBadge';
import type {LibraryDocumentStatus} from './use-library-document-statuses';

export type LibraryStatusGroup = 'all' | 'processing' | 'ready' | 'attention';
export type LibraryAvailability = {
  group: LibraryStatusGroup;
  tone: StatusBadgeTone;
  label: string;
  progress?: 0 | 1 | 2 | 3;
  detail?: string;
};

const UNKNOWN: LibraryAvailability = {group: 'all', tone: 'neutral', label: '全文待核验'};
const MISSING: LibraryAvailability = {group: 'all', tone: 'neutral', label: '无全文'};
const STORED: LibraryAvailability = {group: 'all', tone: 'neutral', label: '已保存'};
const PARSED: LibraryAvailability = {group: 'all', tone: 'neutral', label: '已解析'};
const PARSING: LibraryAvailability = {group: 'processing', tone: 'processing', label: '解析中', progress: 0};
const REQUESTED: LibraryAvailability = {group: 'processing', tone: 'processing', label: '请求解析', progress: 0};
const INDEXING: LibraryAvailability = {group: 'processing', tone: 'processing', label: '索引中', progress: 1};
const QUEUED: LibraryAvailability = {group: 'processing', tone: 'processing', label: '等待索引', progress: 1};
const READY: LibraryAvailability = {group: 'ready', tone: 'ready', label: '就绪', progress: 3};
const ARCHIVED: LibraryAvailability = {group: 'all', tone: 'neutral', label: '已归档'};

/** A parse receipt alone never proves semantic index readiness. */
export function libraryAvailability(item: ResearchLibraryItem, receipt?: LibraryDocumentStatus,
  fallbackDocuments?: readonly ResearchDocument[], requested = false): LibraryAvailability {
  if (item.archived) return ARCHIVED;
  if (requested) return REQUESTED;
  const documents = receipt?.documents ?? fallbackDocuments;
  if (documents === undefined) return UNKNOWN;
  if (documents.length === 0) return MISSING;
  if (documents.some(document => document.status === 'parsing')) return PARSING;
  const indexed = receipt?.documents ?? [];
  if (indexed.some(document => document.currentParseId !== null && document.status === 'ready' && document.indexStatus === 'ready')) return READY;
  if (indexed.some(document => document.indexStatus === 'running')) return INDEXING;
  if (indexed.some(document => document.indexStatus === 'queued')) return QUEUED;
  const failed = documents.find(document => document.status === 'failed' || ('indexStatus' in document && document.indexStatus === 'failed'));
  if (failed !== undefined) return {group: 'attention', tone: 'danger', label: '处理失败', detail: failed.error ?? undefined};
  const cancelled = documents.find(document => document.status === 'cancelled');
  if (cancelled !== undefined) return {group: 'attention', tone: 'warning', label: '已取消', detail: cancelled.error ?? undefined};
  if (documents.some(document => document.currentParseId !== null)) return PARSED;
  return STORED;
}
