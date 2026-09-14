import { BookOpen, Link2, Send, Unlink } from 'lucide-react';
import type { ResearchDocument, ResearchDocumentParse, ResearchLibraryItem, ResearchLiterature } from '../../../shared/types';

export function ResearchLibraryPanel({
  doi,
  items,
  projectId,
  onChangeDoi,
  onImportDoi,
  onImportRecord,
  onLink,
  onOpen,
  onQueryChange,
  onSearch,
  onSearchLibrary,
  onScopeChange,
  openContent,
  openDocuments,
  openItem,
  query,
  results,
  scope,
  working
}: {
  doi: string;
  items: ResearchLibraryItem[];
  projectId: string | null;
  onChangeDoi: (value: string) => void;
  onImportDoi: () => void;
  onImportRecord: (record: ResearchLiterature) => void;
  onLink: (item: ResearchLibraryItem, linked: boolean) => void;
  onOpen: (item: ResearchLibraryItem) => void;
  onQueryChange: (value: string) => void;
  onSearch: () => void;
  onSearchLibrary: () => void;
  onScopeChange: (value: 'project' | 'all') => void;
  openContent: ResearchDocumentParse | null;
  openDocuments: ResearchDocument[];
  openItem: ResearchLibraryItem | null;
  query: string;
  results: ResearchLiterature[];
  scope: 'project' | 'all';
  working: boolean;
}): React.JSX.Element {
  return (
    <section className="research-tool-panel" data-testid="research-library-panel">
      <div className="research-tool-heading">
        <div>
          <div className="research-section-label">Literature Library</div>
          <h2>文献库</h2>
          <p>检索开放论文，导入 DOI，阅读已解析全文，并关联到当前项目。</p>
        </div>
        <form className="research-search-form" onSubmit={(event) => { event.preventDefault(); onSearch(); onSearchLibrary(); }}>
          <input aria-label="检索或筛选文献" data-testid="research-library-query" value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="主题、问题或 DOI" />
          <button className="action-button action-button--primary" disabled={working} type="submit">
            <Send aria-hidden="true" size={15} />
            检索
          </button>
        </form>
      </div>

      <div className="research-library-toolbar">
        <label>
          范围
          <select data-testid="research-library-scope" value={scope} onChange={(event) => onScopeChange(event.target.value === 'all' ? 'all' : 'project')}>
            <option value="project">当前项目</option>
            <option value="all">全局文献库</option>
          </select>
        </label>
        <form className="research-search-form" onSubmit={(event) => { event.preventDefault(); onImportDoi(); }}>
          <input aria-label="导入 DOI" data-testid="research-library-doi" value={doi} onChange={(event) => onChangeDoi(event.target.value)} placeholder="10.xxxx/xxxx" />
          <button className="action-button" disabled={working || doi.trim().length === 0} type="submit">导入 DOI</button>
        </form>
      </div>

      {results.length === 0 ? null : (
        <div className="research-literature-list" data-testid="research-search-results">
          {results.map((record) => (
            <article className="research-literature-row" key={record.id}>
              <div className="research-literature-source">{record.source} {record.publishedYear === null ? '' : `· ${record.publishedYear}`}</div>
              <h3>{record.title}</h3>
              <p>{record.abstract ?? '暂无摘要'}</p>
              <div className="research-literature-meta">
                <span>{record.authors.slice(0, 3).join('、') || '作者信息待补充'}</span>
                <span>{record.doi ?? '无 DOI'}</span>
                <button className="action-button" type="button" disabled={working} onClick={() => onImportRecord(record)}>导入文献库</button>
              </div>
            </article>
          ))}
        </div>
      )}

      <div className="research-library-layout">
        <div className="research-literature-list" data-testid="research-library-list">
          {items.length === 0 ? <div className="research-loading">文献库为空。检索或导入 DOI 后会出现在这里。</div> : items.map((item) => (
            <article className={openItem?.id === item.id ? 'research-literature-row research-library-row--active' : 'research-literature-row'} key={item.id}>
              <div className="research-literature-source">{item.bibliography.citationKey}{item.archived ? ' · 已归档' : ''}</div>
              <h3>{item.metadata.title}</h3>
              <p>{item.metadata.abstract ?? '暂无摘要'}</p>
              <div className="research-literature-meta">
                <span>{item.metadata.authors.slice(0, 3).join('、') || '作者信息待补充'}</span>
                <span>{item.metadata.doi ?? '无 DOI'}</span>
                <button className="action-button" type="button" data-testid={`research-library-open-${item.id}`} onClick={() => onOpen(item)}>
                  <BookOpen aria-hidden="true" size={14} />
                  阅读
                </button>
                <button className="action-button" type="button" data-testid={`research-library-link-${item.id}`} disabled={projectId === null} onClick={() => onLink(item, projectId !== null && !item.projectIds.includes(projectId))}>
                  {projectId !== null && item.projectIds.includes(projectId) ? <Unlink aria-hidden="true" size={14} /> : <Link2 aria-hidden="true" size={14} />}
                  {projectId !== null && item.projectIds.includes(projectId) ? '取消关联' : '关联项目'}
                </button>
              </div>
            </article>
          ))}
        </div>
        <aside className="research-reader" data-testid="research-reader">
          {openItem === null ? <div className="research-loading">选择一条文献阅读解析全文。</div> : (
            <>
              <div className="research-section-label">阅读器</div>
              <h3>{openItem.metadata.title}</h3>
              <p>{openDocuments.length === 0 ? '还没有解析附件。导入 PDF/HTML 后可在这里阅读定位文本。' : `${openDocuments.length} 个附件`}</p>
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
        </aside>
      </div>
    </section>
  );
}
