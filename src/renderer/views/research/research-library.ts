import type {
  ResearchBibliographyFormat,
  ResearchDocument,
  ResearchDocumentParse,
  ResearchLibraryExport,
  ResearchLibraryItem,
  ResearchLiterature
} from '../../../shared/types';
import { unwrap } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';
import { createProjectionController } from './research-projection';

export type ResearchLibraryAdapter = {
  searchLiterature(request: { query: string; sources: Array<'openalex' | 'crossref' | 'semantic_scholar' | 'arxiv' | 'pubmed' | 'europe_pmc'>; limit: number }): Promise<ResearchLiterature[]>;
  listLibrary(request: { projectId: string | null; query: string; includeArchived: boolean; limit: number }): Promise<ResearchLibraryItem[]>;
  importDoi(request: { doi: string; projectId: string | null }): Promise<unknown>;
  importBibliography(request: { sourcePath: string; format: ResearchBibliographyFormat; projectId: string | null }): Promise<unknown>;
  exportBibliography(request: { ids: string[]; format: ResearchBibliographyFormat }): Promise<ResearchLibraryExport>;
  importRecord(request: { record: ResearchLiterature; citationKey: string; projectId: string | null }): Promise<unknown>;
  linkItem(request: { id: string; projectId: string; linked: boolean }): Promise<unknown>;
  listDocuments(request: { libraryItemId: string }): Promise<ResearchDocument[]>;
  getDocumentContent(request: { documentId: string; parseId: string }): Promise<ResearchDocumentParse>;
  importDocument(request: { target: 'library-item'; sourcePath: string; libraryItemId: string; projectId: string | null }): Promise<ResearchDocument>;
  parseDocument(request: { documentId: string }): Promise<unknown>;
  selectFile(): Promise<string | null>;
};

export type ResearchLibrarySnapshot = {
  query: string;
  results: ResearchLiterature[];
  items: ResearchLibraryItem[];
  scope: 'project' | 'all';
  doi: string;
  bibliographyFormat: ResearchBibliographyFormat;
  selectedIds: string[];
  exportPreview: ResearchLibraryExport | null;
  openItem: ResearchLibraryItem | null;
  openDocuments: ResearchDocument[];
  openContent: ResearchDocumentParse | null;
  working: boolean;
  error: string | null;
};

export type ResearchLibraryProjection = {
  getSnapshot(): ResearchLibrarySnapshot;
  subscribe(listener: (snapshot: ResearchLibrarySnapshot) => void): () => void;
  setProject(projectId: string | null): void;
  setQuery(value: string): void;
  setDoi(value: string): void;
  setFormat(value: ResearchBibliographyFormat): void;
  setScope(value: 'project' | 'all'): Promise<void>;
  toggleSelected(id: string): void;
  load(): Promise<void>;
  search(): Promise<void>;
  importDoi(): Promise<void>;
  importBibliography(): Promise<void>;
  exportBibliography(): Promise<void>;
  importRecord(record: ResearchLiterature): Promise<void>;
  link(item: ResearchLibraryItem, linked: boolean): Promise<void>;
  open(item: ResearchLibraryItem): Promise<void>;
  importDocument(): Promise<void>;
  clearError(): void;
};

const emptySnapshot = (): ResearchLibrarySnapshot => ({
  query: '',
  results: [],
  items: [],
  scope: 'project',
  doi: '',
  bibliographyFormat: 'bibtex',
  selectedIds: [],
  exportPreview: null,
  openItem: null,
  openDocuments: [],
  openContent: null,
  working: false,
  error: null
});

export function createResearchLibraryProjection(adapter: ResearchLibraryAdapter): ResearchLibraryProjection {
  const projection = createProjectionController<ResearchLibrarySnapshot>({
    empty: emptySnapshot,
    copy(value) {
      return {
        ...value,
        results: [...value.results],
        items: [...value.items],
        selectedIds: [...value.selectedIds],
        openDocuments: [...value.openDocuments]
      };
    },
    same(left, right) {
      return left.query === right.query
        && left.scope === right.scope
        && left.doi === right.doi
        && left.bibliographyFormat === right.bibliographyFormat
        && left.working === right.working
        && left.error === right.error
        && left.results === right.results
        && left.items === right.items
        && left.selectedIds === right.selectedIds
        && left.exportPreview === right.exportPreview
        && left.openItem === right.openItem
        && left.openDocuments === right.openDocuments
        && left.openContent === right.openContent;
    }
  });
  let projectId: string | null = null;

  async function loadItems(token: number, scope = projection.peek().scope, query = projection.peek().query): Promise<void> {
    const items = await adapter.listLibrary({
      projectId: scope === 'project' ? projectId : null,
      query: query.trim(),
      includeArchived: false,
      limit: 100
    });
    if (!projection.isCurrent(token)) return;
    projection.assign({ items });
  }

  async function loadReader(item: ResearchLibraryItem, token: number): Promise<void> {
    const documents = await adapter.listDocuments({ libraryItemId: item.id });
    if (!projection.isCurrent(token)) return;
    const ready = documents.find((document) => document.status === 'ready' && document.currentParseId !== null);
    const openContent = ready?.currentParseId === null || ready === undefined
      ? null
      : await adapter.getDocumentContent({ documentId: ready.id, parseId: ready.currentParseId });
    if (!projection.isCurrent(token)) return;
    projection.assign({ openItem: item, openDocuments: documents, openContent });
  }

  return {
    getSnapshot() {
      return projection.getSnapshot();
    },
    subscribe(listener) {
      return projection.subscribe(listener);
    },
    setProject(next) {
      projectId = next;
    },
    setQuery(value) {
      projection.assign({ query: value });
    },
    setDoi(value) {
      projection.assign({ doi: value });
    },
    setFormat(value) {
      projection.assign({ bibliographyFormat: value });
    },
    async setScope(value) {
      projection.assign({ scope: value });
      await projection.runExclusive(async (token) => {
        await loadItems(token, value);
      }, { busy: '当前命令仍在进行。', failed: '文献库加载失败。' });
    },
    toggleSelected(id) {
      const selectedIds = projection.peek().selectedIds;
      projection.assign({
        selectedIds: selectedIds.includes(id) ? selectedIds.filter((item) => item !== id) : [...selectedIds, id]
      });
    },
    async load() {
      await projection.runExclusive(async (token) => {
        await loadItems(token);
      }, { busy: '当前命令仍在进行。', failed: '文献库加载失败。' });
    },
    async search() {
      const query = projection.peek().query.trim();
      if (query.length === 0) return;
      await projection.runExclusive(async (token) => {
        const results = await adapter.searchLiterature({
          query,
          sources: ['openalex', 'crossref', 'semantic_scholar', 'arxiv', 'pubmed', 'europe_pmc'],
          limit: 20
        });
        if (!projection.isCurrent(token)) return;
        projection.assign({ results });
        await loadItems(token);
      }, { busy: '当前命令仍在进行。', failed: '论文检索失败。' });
    },
    async importDoi() {
      const doi = projection.peek().doi.trim();
      if (doi.length === 0) return;
      await projection.runExclusive(async (token) => {
        await adapter.importDoi({ doi, projectId });
        if (!projection.isCurrent(token)) return;
        await loadItems(token);
      }, { busy: '当前命令仍在进行。', failed: 'DOI 导入失败。' });
    },
    async importBibliography() {
      const sourcePath = await adapter.selectFile();
      if (sourcePath === null) return;
      await projection.runExclusive(async (token) => {
        await adapter.importBibliography({
          sourcePath,
          format: projection.peek().bibliographyFormat,
          projectId
        });
        if (!projection.isCurrent(token)) return;
        await loadItems(token);
      }, { busy: '当前命令仍在进行。', failed: '参考文献导入失败。' });
    },
    async exportBibliography() {
      const snapshot = projection.peek();
      if (snapshot.selectedIds.length === 0) return;
      await projection.runExclusive(async (token) => {
        const exportPreview = await adapter.exportBibliography({
          ids: snapshot.selectedIds,
          format: snapshot.bibliographyFormat
        });
        if (!projection.isCurrent(token)) return;
        projection.assign({ exportPreview });
      }, { busy: '当前命令仍在进行。', failed: '参考文献导出失败。' });
    },
    async importRecord(record) {
      await projection.runExclusive(async (token) => {
        await adapter.importRecord({
          record,
          citationKey: (record.doi ?? record.externalId).replace(/[^A-Za-z0-9]+/g, '').slice(0, 40) || 'cite',
          projectId
        });
        if (!projection.isCurrent(token)) return;
        await loadItems(token);
      }, { busy: '当前命令仍在进行。', failed: '文献导入失败。' });
    },
    async link(item, linked) {
      if (projectId === null) return;
      const currentProjectId = projectId;
      await projection.runExclusive(async (token) => {
        await adapter.linkItem({ id: item.id, projectId: currentProjectId, linked });
        if (!projection.isCurrent(token)) return;
        await loadItems(token);
      }, { busy: '当前命令仍在进行。', failed: '文献关联失败。' });
    },
    async open(item) {
      await projection.runExclusive(async (token) => {
        await loadReader(item, token);
      }, { busy: '当前命令仍在进行。', failed: '文献阅读失败。' });
    },
    async importDocument() {
      const openItem = projection.peek().openItem;
      if (openItem === null) return;
      const sourcePath = await adapter.selectFile();
      if (sourcePath === null) return;
      await projection.runExclusive(async (token) => {
        const imported = await adapter.importDocument({
          target: 'library-item',
          sourcePath,
          libraryItemId: openItem.id,
          projectId
        });
        await adapter.parseDocument({ documentId: imported.id });
        if (!projection.isCurrent(token)) return;
        await loadReader(openItem, token);
      }, { busy: '当前命令仍在进行。', failed: '附件导入失败。' });
    },
    clearError() {
      projection.clearError();
    }
  };
}

export function createResearchLibraryAdapter(client: RocClient): ResearchLibraryAdapter {
  const research = client.api.research;
  return {
    async searchLiterature(request) {
      return unwrap('论文检索', await research.searchLiterature(request));
    },
    async listLibrary(request) {
      return unwrap('文献库', await research.listLibrary(request));
    },
    async importDoi(request) {
      return unwrap('导入 DOI', await research.importLibraryDoi(request));
    },
    async importBibliography(request) {
      return unwrap('导入参考文献', await research.importBibliography(request));
    },
    async exportBibliography(request) {
      return unwrap('导出参考文献', await research.exportBibliography(request));
    },
    async importRecord(request) {
      return unwrap('导入文献', await research.importLibraryRecord(request));
    },
    async linkItem(request) {
      return unwrap('关联文献', await research.linkLibraryItem(request));
    },
    async listDocuments(request) {
      return unwrap('文献附件', await research.listDocuments(request));
    },
    async getDocumentContent(request) {
      return unwrap('文献全文', await research.getDocumentContent(request));
    },
    async importDocument(request) {
      return unwrap('导入附件', await research.importDocument(request));
    },
    async parseDocument(request) {
      return unwrap('解析附件', await research.parseDocument(request));
    },
    async selectFile() {
      const selection = unwrap('选择文件', await client.api.files.selectFromDialog());
      return selection?.filePaths[0] ?? null;
    }
  };
}
