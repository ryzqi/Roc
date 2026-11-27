import {AnimatePresence} from 'motion/react';
import {BookOpen, FilePlus2, Sparkles} from 'lucide-react';
import {CopyFeedbackIcon} from '../shared/CopyFeedbackIcon';
import {LibraryPresence} from './LibraryPresence';
import {useWorkspaceScope} from '../app/workspace-scope';
import {useCopyFeedback} from '../shared/hooks/use-copy-feedback';
import {ActionButton} from '../shared/form-ui';
import {ErrorBar} from '../shell/ErrorBar';
import {EmptyState} from '../shell/EmptyState';
import {ResourceStatus} from './ResourceStatus';
import {PaperMetaCard} from './PaperMetaCard';
import {StatusBadge} from '../shared/StatusBadge';
import {libraryAvailability} from './library-availability';
import {useLibraryDocumentStatus} from './use-library-document-statuses';
import type {LiteratureStore} from './use-literature-store';
import type {ResearchDocument} from '../../shared/types';
import './library-inspector.css';

/** Metadata and receipts share one selection; no parsing state is inferred from time. */
type LibraryInspectorProps = {
  literature: LiteratureStore;
  direction?: -1 | 0 | 1;
  onRead: (id: string) => void;
  onOpenKnowledge: (target: 'index' | 'wiki') => void;
};

export function LibraryInspector(props: LibraryInspectorProps): React.JSX.Element {
  const {literature, direction = 0} = props;
  return <div className="library-inspector-handoff">
    <AnimatePresence initial={false}>
      <LibraryPresence key={literature.selectedId ?? 'empty'} className="library-inspector-page"
        event="content-handoff" direction={direction}>
        <LibraryInspectorContent {...props}/>
      </LibraryPresence>
    </AnimatePresence>
  </div>;
}

function LibraryInspectorContent({literature, onRead, onOpenKnowledge}: LibraryInspectorProps): React.JSX.Element {
  const scope = useWorkspaceScope();
  const copy = useCopyFeedback();
  const item = literature.selected;
  const receipt = useLibraryDocumentStatus(literature.documentStatusSource, item?.id ?? '');
  if (literature.selectedStatus === 'error') return <ErrorBar error={{
    level: 'page', message: literature.selectedError ?? '读取文献失败', retry: literature.reloadSelected
  }}/>;
  if (item === null) return <EmptyState compact icon={BookOpen} title="选择一篇文献" testId="literature-inspector-empty"/>;
  const documents = literature.documents.filter(document => document.libraryItemId === item.id);
  const document = documents.find(entry => entry.currentParseId !== null) ?? documents[0] ?? null;
  const openDocument = (entry: ResearchDocument): void => {
    // Managed documents are opened by receipt identity through the reader, not
    // as workspace-relative files. The reader owns the preview protocol.
    if (entry.currentParseId === null) onRead(item.id);
    else scope.openLiterature({kind: 'reader', libraryItemId: item.id, parseId: entry.currentParseId});
  };
  const availability = libraryAvailability(item, receipt,
    literature.documentsStatus === 'ready' ? documents : undefined,
    documents.some(entry => literature.parsingDocumentIds?.has(entry.id)));
  return <div className="library-inspector-content" data-library-item={item.id}>
    <section className="library-inspector-meta" aria-label="完整文献信息">
      <div data-testid="literature-inspector-title"><PaperMetaCard item={item} showIdentifiers/></div>
      <StatusBadge tone={availability.tone} label={availability.label} progress={availability.progress}
        title={availability.detail} testId="literature-inspector-status"/>
      <dl className="library-inspector-fields">
        {item.metadata.citationCount === null ? null : <><dt>被引</dt><dd>{item.metadata.citationCount.toLocaleString('zh-CN')} 次</dd></>}
        <dt>来源</dt><dd>{item.metadata.source}</dd>
        <dt>版本</dt><dd>{item.revision}</dd>
        {item.archived ? <><dt>归档</dt><dd>已归档</dd></> : null}
      </dl>
      <div className="library-inspector-actions">
        <ActionButton variant="compact" onClick={() => onRead(item.id)} data-testid="literature-inspector-read">
          <BookOpen size={14} aria-hidden="true"/>阅读
        </ActionButton>
        <ActionButton variant="compact" onClick={() => copy.copy(item.bibliography.citationKey)}>
          <CopyFeedbackIcon copied={copy.copied}/>{copy.copied ? '已复制' : '复制引用键'}
        </ActionButton>
        <ActionButton variant="compact" disabled={literature.projectId === null || !scope.writable} loading={literature.assistant.pending}
          onClick={() => void literature.askAssistantAboutSelected()}>
          <Sparkles size={14} aria-hidden="true"/>问 AI
        </ActionButton>
      </div>
      {copy.error === null ? null : <p role="alert">{copy.error}</p>}
      {literature.assistant.error === null ? null : <p role="alert">{literature.assistant.error}</p>}
    </section>
    <section className="library-inspector-documents" aria-label="文献文件">
      <h3>文件</h3>
      {literature.documentsError === null ? null : <ErrorBar error={{
        level: 'page', message: literature.documentsError, retry: literature.reloadDocuments
      }}/>}
      {documents.map(entry => <button type="button" key={entry.id} className="library-inspector-file"
        onClick={() => openDocument(entry)}>{entry.filename}</button>)}
      {documents.length > 0 ? null : <ActionButton variant="compact" disabled={!scope.writable}
        onClick={() => literature.requestImport('document')}><FilePlus2 size={14} aria-hidden="true"/>添加 PDF</ActionButton>}
    </section>
    <ResourceStatus key={JSON.stringify([literature.projectId, item.id])} itemId={item.id} document={document}
      presentation="inspector" onMetadata={() => {}}
      onPdf={() => document === null ? literature.requestImport('document') : openDocument(document)}
      onParse={() => document === null ? literature.requestImport('document') : onRead(item.id)}
      onKnowledge={onOpenKnowledge}/>
  </div>;
}
