import { BookOpen, Link2, Send, Unlink } from 'lucide-react';
import type { ResearchBibliographyFormat, ResearchDocument, ResearchDocumentParse, ResearchLibraryExport, ResearchLibraryItem, ResearchLiterature } from '../../../shared/types';
import { Select, TextInput } from '../../components/ui';
import { usePagedItems } from './research-list-page';

export function ResearchLibraryPanel({
  bibliographyFormat,
  doi,
  exportPreview,
  items,
  projectId,
  selectedIds,
  onChangeDoi,
  onChangeFormat,
  onExport,
  onImportDoi,
  onImportFile,
  onImportRecord,
  onImportDocument,
  onLink,
  onOpen,
  onQueryChange,
  onSearch,
  onScopeChange,
  onToggleSelected,
  openContent,
  openDocuments,
  openItem,
  query,
  results,
  scope,
  working,
  readOnly = false
}: {
  bibliographyFormat: ResearchBibliographyFormat;
  doi: string;
  exportPreview: ResearchLibraryExport | null;
  items: ResearchLibraryItem[];
  projectId: string | null;
  selectedIds: string[];
  onChangeDoi: (value: string) => void;
  onChangeFormat: (value: ResearchBibliographyFormat) => void;
  onExport: () => void;
  onImportDoi: () => void;
  onImportFile: () => void;
  onImportRecord: (record: ResearchLiterature) => void;
  onImportDocument: () => void;
  onLink: (item: ResearchLibraryItem, linked: boolean) => void;
  onOpen: (item: ResearchLibraryItem) => void;
  onQueryChange: (value: string) => void;
  onSearch: () => void;
  onScopeChange: (value: 'project' | 'all') => void;
  onToggleSelected: (id: string) => void;
  openContent: ResearchDocumentParse | null;
  openDocuments: ResearchDocument[];
  openItem: ResearchLibraryItem | null;
  query: string;
  results: ResearchLiterature[];
  scope: 'project' | 'all';
  working: boolean;
  readOnly?: boolean;
}): React.JSX.Element {
  const writeBlocked = working || readOnly;
  const resultPage = usePagedItems(results, query);
  const itemPage = usePagedItems(items, `${scope}:${query}`);
  return (
    <section className="research-tool-panel" data-testid="research-library-panel">
      <div className="research-tool-heading">
        <div>
          <h2>文献库</h2>
          <p>检索开放论文，导入 DOI 或参考文献文件，阅读已解析全文，并关联到当前项目。</p>
        </div>
        <form className="research-search-form" onSubmit={(event) => { event.preventDefault(); onSearch(); }}>
          <TextInput aria-label="检索或筛选文献" data-testid="research-library-query" value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="主题、问题或 DOI" />
          <button className="action-button action-button--primary" disabled={working} type="submit">
            <Send aria-hidden="true" size={15} />
            检索
          </button>
        </form>
      </div>

      <div className="research-library-toolbar">
        <label>
          范围
          <Select data-testid="research-library-scope" value={scope} onChange={(event) => onScopeChange(event.target.value === 'all' ? 'all' : 'project')}>
            <option value="project">当前项目</option>
            <option value="all">全局文献库</option>
          </Select>
        </label>
        <form className="research-search-form" onSubmit={(event) => { event.preventDefault(); onImportDoi(); }}>
          <TextInput aria-label="导入 DOI" data-testid="research-library-doi" value={doi} onChange={(event) => onChangeDoi(event.target.value)} placeholder="10.xxxx/xxxx" />
          <button className="action-button" disabled={writeBlocked || doi.trim().length === 0} type="submit">导入 DOI</button>
        </form>
        <label>
          参考文献格式
          <Select data-testid="research-library-format" value={bibliographyFormat} onChange={(event) => onChangeFormat(readFormat(event.target.value))}>
            <option value="bibtex">BibTeX</option>
            <option value="biblatex">BibLaTeX</option>
            <option value="csl-json">CSL JSON</option>
          </Select>
        </label>
        <button className="action-button" disabled={writeBlocked} type="button" data-testid="research-library-import-file" onClick={onImportFile}>导入文件</button>
        <button className="action-button" disabled={writeBlocked || selectedIds.length === 0} type="button" data-testid="research-library-export" onClick={onExport}>导出选中</button>
      </div>

      {results.length === 0 ? null : (
        <div className="research-literature-list" data-testid="research-search-results">
          {resultPage.visible.map((record) => (
            <article className="research-literature-row" key={record.id}>
              <div className="research-literature-source">{record.source} {record.publishedYear === null ? '' : `· ${record.publishedYear}`}</div>
              <h3>{record.title}</h3>
              <p>{record.abstract ?? '暂无摘要'}</p>
              <div className="research-literature-meta">
                <span>{record.authors.slice(0, 3).join('、') || '作者信息待补充'}</span>
                <span>{record.doi ?? '无 DOI'}</span>
                <button className="action-button" type="button" disabled={writeBlocked} onClick={() => onImportRecord(record)}>导入文献库</button>
              </div>
            </article>
          ))}
          {resultPage.remaining === 0 ? null : (
            <button className="action-button" data-testid="research-library-more-results" type="button" onClick={resultPage.showMore}>
              继续加载检索结果（剩余 {resultPage.remaining}）
            </button>
          )}
        </div>
      )}

      <div className="research-library-layout">
        <div className="research-literature-list" data-testid="research-library-list">
          {items.length === 0 ? <div className="research-loading">文献库为空。检索、导入 DOI 或参考文献文件后会出现在这里。</div> : itemPage.visible.map((item) => (
            <article className={openItem?.id === item.id ? 'research-literature-row research-library-row--active' : 'research-literature-row'} key={item.id}>
              <label className="research-literature-source">
                <input type="checkbox" data-testid={`research-library-select-${item.id}`} checked={selectedIds.includes(item.id)} onChange={() => onToggleSelected(item.id)} />
                {item.bibliography.citationKey}{item.archived ? ' · 已归档' : ''}
              </label>
              <h3>{item.metadata.title}</h3>
              <p>{item.metadata.abstract ?? '暂无摘要'}</p>
              <div className="research-literature-meta">
                <span>{item.metadata.authors.slice(0, 3).join('、') || '作者信息待补充'}</span>
                <span>{item.metadata.doi ?? '无 DOI'}</span>
                <button className="action-button" type="button" data-testid={`research-library-open-${item.id}`} onClick={() => onOpen(item)}>
                  <BookOpen aria-hidden="true" size={14} />
                  阅读
                </button>
                <button className="action-button" type="button" data-testid={`research-library-link-${item.id}`} disabled={writeBlocked || projectId === null} onClick={() => onLink(item, projectId !== null && !item.projectIds.includes(projectId))}>
                  {projectId !== null && item.projectIds.includes(projectId) ? <Unlink aria-hidden="true" size={14} /> : <Link2 aria-hidden="true" size={14} />}
                  {projectId !== null && item.projectIds.includes(projectId) ? '取消关联' : '关联项目'}
                </button>
              </div>
            </article>
          ))}
          {itemPage.remaining === 0 ? null : (
            <button className="action-button" data-testid="research-library-more-items" type="button" onClick={itemPage.showMore}>
              继续加载文献（剩余 {itemPage.remaining}）
            </button>
          )}
        </div>
        <aside className="research-reader" data-testid="research-reader">
          {openItem === null ? <div className="research-loading">选择一条文献阅读解析全文。</div> : (
            <>
              <div className="research-section-label">阅读器</div>
              <h3>{openItem.metadata.title}</h3>
              <p>{openDocuments.length === 0 ? '还没有解析附件。导入 PDF/HTML 后可在这里阅读定位文本。' : `${openDocuments.length} 个附件`}</p>
              <div className="research-stage-actions">
                <button className="action-button action-button--primary" disabled={writeBlocked} type="button" data-testid="research-document-import" onClick={onImportDocument}>导入附件</button>
              </div>
              {openDocuments.map((document) => (
                <p className={document.status === 'failed' ? 'research-stage-error' : 'research-stage-copy'} key={document.id} data-testid={`research-document-status-${document.id}`}>
                  {document.filename} · {documentStatusLabel(document.status)}{document.error === null ? '' : ` · ${researchRuntimeErrorLabel(document.error)}`}
                </p>
              ))}
              {openContent === null ? null : (
                <div className="research-reader-content" data-testid="research-reader-content">
                  {openContent.content.blocks.map((block) => (
                    <article key={block.id}>
                      <span>{block.locator}</span>
                      <p>{block.text}</p>
                    </article>
                  ))}
                </div>
              )}
            </>
          )}
          {exportPreview === null ? null : (
            <pre className="research-reader-content" data-testid="research-library-export-preview">{[exportPreview.filename, exportPreview.content].join(String.fromCharCode(10))}</pre>
          )}
        </aside>
      </div>
    </section>
  );
}

function readFormat(value: string): ResearchBibliographyFormat {
  if (value === 'biblatex' || value === 'csl-json') return value;
  return 'bibtex';
}

function documentStatusLabel(status: ResearchDocument['status']): string {
  if (status === 'ready') return '已解析';
  if (status === 'parsing') return '解析中';
  if (status === 'failed') return '解析失败';
  if (status === 'cancelled') return '已取消';
  return '已导入';
}

function researchRuntimeErrorLabel(code: string): string {
  if (code === 'research_models_unavailable') return '解析模型尚未下载';
  return code;
}
