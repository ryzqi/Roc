import {memo, useCallback} from 'react';
import {BookOpen, Check, Copy, MoreHorizontal, Sparkles} from 'lucide-react';
import type {ResearchDocument, ResearchLibraryItem} from '../../shared/types';
import {StatusBadge} from '../shared/StatusBadge';
import {useCopyFeedback} from '../shared/hooks/use-copy-feedback';
import {libraryItemTitle} from './format';
import {PaperMetaCard} from './PaperMetaCard';
import {libraryAvailability} from './library-availability';
import {useLibraryDocumentStatus, type LibraryDocumentStatusSource} from './use-library-document-statuses';

export type LibraryRowActions = {
  register: (id: string, element: HTMLButtonElement | null) => void;
  focus: (id: string) => void;
  navigate: (id: string, key: string) => boolean;
  open: (id: string) => void;
  read: (id: string) => void;
  ask: (item: ResearchLibraryItem) => void;
  copy: (value: string) => void;
  check: (id: string, checked: boolean) => void;
  remove: (items: readonly ResearchLibraryItem[]) => void;
  menu: (item: ResearchLibraryItem, target: HTMLElement, point?: {x: number; y: number}) => void;
};

type LibraryPaperRowProps = {
  item: ResearchLibraryItem;
  selected: boolean;
  selecting: boolean;
  checked: boolean;
  tabIndex: number;
  hasReader: boolean;
  canAsk: boolean;
  requested: boolean;
  statusSource?: LibraryDocumentStatusSource;
  fallbackDocuments?: readonly ResearchDocument[];
  actions: LibraryRowActions;
};

/** Fixed geometry and a per-paper receipt subscription keep idle rows quiet. */
export const LibraryPaperRow = memo(function LibraryPaperRow({
  item, selected, selecting, checked, tabIndex, hasReader, canAsk, requested,
  statusSource, fallbackDocuments, actions
}: LibraryPaperRowProps): React.JSX.Element {
  const receipt = useLibraryDocumentStatus(statusSource, item.id);
  const availability = libraryAvailability(item, receipt, fallbackDocuments, requested);
  const register = useCallback((element: HTMLButtonElement | null) => actions.register(item.id, element), [item.id, actions]);
  const title = libraryItemTitle(item);
  return <div className="library-row" data-library-row data-selected={selected}
    onFocusCapture={() => actions.focus(item.id)}
    onContextMenu={event => {
      event.preventDefault();
      const rowButton = event.currentTarget.querySelector<HTMLButtonElement>('.library-row-open');
      if (rowButton !== null) actions.menu(item, rowButton, {x: event.clientX, y: event.clientY});
    }}>
    <label className="library-row-selection">
      <input type="checkbox" checked={checked} tabIndex={selecting ? tabIndex : -1}
        aria-label={`选择文献 ${title}`}
        onChange={event => actions.check(item.id, event.target.checked)}/>
    </label>
    <button type="button" ref={register} tabIndex={tabIndex} className="library-row-open"
      aria-current={selected ? 'true' : undefined} data-testid={`literature-row-${item.id}`}
      onClick={() => actions.open(item.id)} onDoubleClick={() => {if (hasReader) actions.read(item.id);}}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.defaultPrevented) return;
        if (actions.navigate(item.id, event.key)) {event.preventDefault(); return;}
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault(); actions.menu(item, event.currentTarget); return;
        }
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.key === 'Enter' && hasReader) {event.preventDefault(); actions.read(item.id);}
        else if (event.key.toLowerCase() === 'c') {event.preventDefault(); actions.copy(item.bibliography.citationKey);}
        else if (event.key.toLowerCase() === 'a' && canAsk) {event.preventDefault(); actions.ask(item);}
        else if (event.key === ' ' && selecting) {event.preventDefault(); actions.check(item.id, !checked);}
      }}>
      <PaperMetaCard item={item} dense/>
    </button>
    <span className="library-row-status">
      <StatusBadge tone={availability.tone} label={availability.label} progress={availability.progress}
        title={availability.detail ?? availability.label} testId={`literature-fulltext-${item.id}`}/>
    </span>
    <div className="library-row-actions">
      {hasReader ? <button type="button" className="library-icon-button" tabIndex={tabIndex}
        aria-label={`阅读文献 ${title}`} title="阅读文献 (Enter)" data-testid={`literature-read-${item.id}`}
        onClick={() => actions.read(item.id)}><BookOpen size={14} aria-hidden="true"/></button> : null}
      <CitationKeyCopy key={item.bibliography.citationKey} itemId={item.id}
        citationKey={item.bibliography.citationKey} tabIndex={tabIndex}/>
      <button type="button" className="library-icon-button library-row-ask" tabIndex={tabIndex}
        disabled={!canAsk} aria-label={`问 AI ${title}`} title="问 AI (A)"
        data-testid={`literature-ask-${item.id}`} onClick={() => actions.ask(item)}>
        <Sparkles size={14} aria-hidden="true"/>
      </button>
      <button type="button" className="library-icon-button" tabIndex={tabIndex}
        aria-label={`文献操作 ${title}`} title="文献操作 (Shift+F10)" data-testid={`literature-more-${item.id}`}
        onClick={event => actions.menu(item, event.currentTarget)}><MoreHorizontal size={14} aria-hidden="true"/></button>
    </div>
  </div>;
});

function CitationKeyCopy({itemId, citationKey, tabIndex}: {itemId: string; citationKey: string; tabIndex: number}): React.JSX.Element {
  const {copied, error, copy} = useCopyFeedback();
  return <>
    <button type="button" tabIndex={tabIndex} onClick={() => copy(citationKey)}
      aria-label={`${copied ? '已复制引用键' : '复制引用键'} ${citationKey}`}
      title={copied ? '已复制' : '复制引用键 (C)'} data-testid={`literature-citekey-copy-${itemId}`}
      className="library-row-copy library-icon-button">
      {copied ? <Check size={14} aria-hidden="true"/> : <Copy size={14} aria-hidden="true"/>}
    </button>
    {error ? <p role="alert" className="library-row-error">{error}</p> : null}
  </>;
}
