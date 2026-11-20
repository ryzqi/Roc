import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {PaperSource} from '../../../shared/schemas/research-paper-card';
import type {WikiPage, WikiSection} from '../../../shared/schemas/research-wiki-pages';
import type {ResearchPaperCards} from './paper-card-service';
import type {ResearchWikiRepository} from './wiki-repository';

const id = z.string().trim().min(1).max(300);
export const acquisitionWikiBatchSchema = z.object({
  projectId: id.nullable(), batchId: id, title: id, total: z.number().int().min(1).max(100000),
  readyDocumentIds: z.array(id).max(50)
}).strict();
export type AcquisitionWikiBatchInput = z.infer<typeof acquisitionWikiBatchSchema>;
/** Persisted in the existing Wiki selection, not in a second acquisition ledger. */
export type AcquisitionWikiSelection = {batchId: string; total: number; documentIds: string[]};
export type AcquisitionWikiFailure = {
  code: 'wiki_source_missing' | 'wiki_paper_card_pending' | 'wiki_paper_card_failed' |
    'wiki_source_pending' | 'wiki_source_failed' | 'wiki_source_stale' | 'wiki_source_invalid' |
    'wiki_topic_failed' | 'wiki_topic_stale' | 'wiki_topic_human_override' | 'wiki_project_required';
  retryable: boolean;
};
export type AcquisitionWikiSource = {
  documentId: string; pageId: string | null; revision: number; ready: boolean;
  publication: 'wiki_page' | 'paper_card'; generation: string | null;
  status: 'missing' | 'pending' | 'failed' | 'stale' | 'ready';
  error: AcquisitionWikiFailure | null;
};
export type AcquisitionWikiOriginal = {source: PaperSource; text: string};
export type AcquisitionWikiSnapshot = {
  receipt: AcquisitionWikiSource; page: WikiPage; version: string;
  sections: WikiSection[]; originals: AcquisitionWikiOriginal[];
};
export type AcquisitionWikiBatch = {
  pageId: string | null; revision: number; ready: boolean;
  status: 'pending' | 'partial' | 'ready' | 'stale' | 'failed' | 'blocked';
  coverage: {total: number; readySources: number; covered: number; missing: number; complete: boolean};
  sources: AcquisitionWikiSource[]; error: AcquisitionWikiFailure | null;
};

export const acquisitionWikiPageId = (projectId: string, batchId: string): string =>
  `wiki_batch_${createHash('sha256').update(JSON.stringify([id.parse(projectId), id.parse(batchId)])).digest('hex')}`;
const roles = [
  ['problem', '研究问题'], ['contribution', '主要贡献'], ['method', '核心方法'],
  ['experimental_setup', '实验条件'], ['results', '结果与消融'], ['limitations', '局限与未知']
] as const;
const clipped = (text: string, length: number): string => text.length > length ? `${text.slice(0, length - 1)}…` : text;

/** A bounded first layer: role-aligned original quotations, never model prose relabelled as evidence. */
export function acquisitionWikiSections(selection: AcquisitionWikiSelection, snapshots: AcquisitionWikiSnapshot[]): WikiSection[] {
  const dependencies = snapshots.map(item => ({kind: 'paper' as const, id: item.receipt.documentId, digest: item.version}));
  const sections: WikiSection[] = [{
    id: 'acquisition:coverage', title: '批次覆盖范围 · 自动生成 · 未人工审核', owner: 'system', status: 'current',
    body: `当前已核验并纳入 ${snapshots.length} / ${selection.total} 篇论文来源页；尚未纳入 ${selection.total - snapshots.length} 篇。\n` +
      '以下按阅读维度并列原文节选与定位信息，作为专题整理的第一层。论文条件和结论分别保留，不据此推断跨论文优劣、共识或科学支持；未提供的术语、分类和研究空白均为 unknown。Paper Card 和此页均为派生草稿，请回到原始 PDF 核查。',
    evidenceIds: [], claimIds: [], links: snapshots.map(item => item.page.page.id), dependencies
  }];
  for (const [role, title] of roles) {
    // At most 12 original citations per section and 50 papers / 100000 characters per page.
    for (let offset = 0; offset < snapshots.length; offset += 12) {
      const group = snapshots.slice(offset, offset + 12), originals: PaperSource[] = [];
      const entries = group.map((snapshot, index) => {
        const section = snapshot.sections.find(item => item.id === `paper:${role}`);
        const reference = section?.body !== 'unknown' ? section?.paperSources?.[0] : undefined;
        const original = reference && snapshot.originals.find(item => item.source.chunkId === reference.chunkId);
        const heading = `[${offset + index + 1}] ${clipped(snapshot.page.page.title, 50)}`;
        if (!original) return `${heading}\nunknown（本维度无已核验的原文引用）。`;
        originals.push(original.source);
        return `${heading}\n原文节选：${clipped(original.text, 120)}\n定位：${clipped(original.source.locator, 60)}；引用 [${offset + index + 1}]，保留原文条件。`;
      });
      sections.push({id: `acquisition:${role}:${offset / 12}`, title: `${title} · 原文对照 ${offset + 1}–${offset + group.length}`,
        body: entries.join('\n\n'), owner: 'system', status: 'current', evidenceIds: [], claimIds: [],
        links: group.map(item => item.page.page.id), paperSources: originals,
        dependencies: dependencies.slice(offset, offset + 12)});
    }
  }
  return sections;
}

/** Main-process adapter. Caller supplies the already-authorized project and import operation membership. */
export class ResearchLiteratureAcquisitionWiki {
  constructor(private readonly wiki: ResearchWikiRepository,
    private readonly cards: Pick<ResearchPaperCards, 'enqueue' | 'wake' | 'retry'>) {}

  readSource(projectId: string | null, documentId: string): AcquisitionWikiSource {
    return this.wiki.acquisitionSource(id.nullable().parse(projectId), id.parse(documentId)).receipt;
  }

  /** Global library publication is the persisted six-section Paper Card; Wiki page revisions require a project. */
  readLibrarySource(documentId: string): {receipt: AcquisitionWikiSource; sections: WikiSection[]} {
    return this.wiki.acquisitionLibrarySource(id.parse(documentId));
  }

  ensureSource(projectId: string | null, documentId: string): AcquisitionWikiSource {
    const source = this.wiki.prepareAcquisitionSource(id.nullable().parse(projectId), id.parse(documentId));
    if (source) {
      try {this.cards.enqueue(source.knowledgeId); this.cards.wake();}
      catch {return {...this.readSource(projectId, documentId), ready: false, status: 'failed',
        error: {code: 'wiki_source_invalid', retryable: true}};}
    }
    return this.readSource(projectId, documentId);
  }

  retrySource(projectId: string | null, documentId: string): AcquisitionWikiSource {
    const current = this.ensureSource(projectId, documentId);
    if (projectId === null) {
      if (current.status === 'failed' || current.status === 'stale') {
        this.wiki.retryAcquisitionLibrarySource(documentId); this.cards.wake();
      }
      return this.readSource(projectId, documentId);
    }
    if (!current.pageId || current.ready) return current;
    if (current.error?.code === 'wiki_paper_card_failed' || current.error?.code === 'wiki_source_invalid') this.cards.retry(projectId, current.pageId);
    else if (current.status === 'stale') this.wiki.recompile(projectId, current.pageId, current.revision);
    else if (current.error?.code === 'wiki_source_failed') this.wiki.recompile(projectId, current.pageId, current.revision);
    return this.readSource(projectId, documentId);
  }

  reconcileBatch(input: AcquisitionWikiBatchInput): AcquisitionWikiBatch {
    return this.wiki.reconcileAcquisitionBatch(acquisitionWikiBatchSchema.parse(input));
  }

  readBatch(projectId: string | null, batchId: string): AcquisitionWikiBatch | null {
    if (projectId === null) {id.parse(batchId); return null;}
    return this.wiki.readAcquisitionBatch(id.parse(projectId), id.parse(batchId));
  }
}
