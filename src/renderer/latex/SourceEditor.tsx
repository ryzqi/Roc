import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, drawSelection, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { search, searchKeymap } from '@codemirror/search';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { useContentPreferences } from '../app/use-content-preferences';
import { tags } from '@lezer/highlight';
import type { InlineSelectionAnchor } from '../canvas/InlineCommandBar';
import {useViewSelected} from '../shared/view-activity';

export type SourceSelection = {
  text: string;
  truncated: boolean;
  from: number;
  to: number;
  lineRange: { start: number; end: number };
  anchor: InlineSelectionAnchor | null;
};

export type SourceReplacement = { from: number; to: number; text: string; expectedDocument: string; nonce: number };

const sourceHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.tagName], color: 'var(--syntax-keyword)' },
  { tag: [tags.string, tags.attributeName], color: 'var(--syntax-string)' },
  { tag: tags.comment, color: 'var(--syntax-comment)' },
  { tag: [tags.number, tags.atom], color: 'var(--syntax-number)' }
]);

const sourceTheme = EditorView.theme({
  '&': { height: '100%', color: 'var(--ink)', backgroundColor: 'var(--bg)' },
  '&.cm-focused': { outline: '2px solid var(--focus-ring)', outlineOffset: '-2px' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono)', fontSize: 'var(--font-code-size)', lineHeight: '1.65' },
  '.cm-content': { padding: '12px 0', caretColor: 'var(--ink)' },
  '.cm-line': { padding: '0 12px' },
  '.cm-gutters': { backgroundColor: 'var(--bg-soft)', color: 'var(--subtle)', borderRight: '0.5px solid var(--line)' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--overlay-hover)' },
  '.cm-cursor': { borderLeftColor: 'var(--ink)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--overlay-active)' },
  '.cm-panels': { backgroundColor: 'var(--surface)', color: 'var(--ink)' },
  '.cm-panel.cm-search': { padding: '8px', fontFamily: 'var(--font-sans)', fontSize: 'var(--font-meta-size)' },
  '.cm-textfield, .cm-button': { background: 'var(--surface)', color: 'var(--ink)', border: '0.5px solid var(--line)', borderRadius: 'var(--r-control)' }
});

/** CodeMirror owns selection, undo, IME and search; React owns saved/draft text. */
export function SourceEditor({ value, readOnly, onChange, onSelectionChange, focusLine, replacement = null }: {
  value: string;
  readOnly: boolean;
  onChange: (value: string) => void;
  onSelectionChange?: (selection: SourceSelection | null) => void;
  focusLine?: { line: number; nonce: number } | null;
  replacement?: SourceReplacement | null;
}): React.JSX.Element {
  const { preferences } = useContentPreferences();
  const selected = useViewSelected();
  const [composing, setComposing] = useState(false);
  const display = selected || composing;
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSelectionRef = useRef(onSelectionChange);
  onSelectionRef.current = onSelectionChange;
  const readOnlyConfig = useRef(new Compartment());
  const initial = useRef(value);
  const retainedState = useRef<EditorState | null>(null);
  const retainedScroll = useRef<ReturnType<EditorView['scrollSnapshot']> | undefined>(undefined);
  const appliedReplacement = useRef<number | null>(null);
  const appliedFocus = useRef<number | null>(null);
  const compositionEndTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useLayoutEffect(() => {
    if (!display || host.current === null) return;
    const editor = new EditorView({
      parent: host.current,
      scrollTo: retainedScroll.current,
      state: retainedState.current ?? EditorState.create({
        doc: initial.current,
        extensions: [
          lineNumbers(), history(), drawSelection(), highlightActiveLine(), EditorView.lineWrapping,
          StreamLanguage.define(stex), syntaxHighlighting(sourceHighlight), sourceTheme,
          search({ top: true }), keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          EditorView.contentAttributes.of({ 'aria-label': '文稿源码', 'data-testid': 'production-latex-content', spellcheck: 'false' }),
          readOnlyConfig.current.of(EditorState.readOnly.of(false)),
          EditorView.domEventHandlers({
            compositionstart: () => {clearTimeout(compositionEndTimer.current); setComposing(true);},
            // CodeMirror flushes the final DOM mutation in a microtask after
            // compositionend. Keep its view through that flush before suspending.
            compositionend: () => {
              compositionEndTimer.current = setTimeout(() => {setComposing(false);}, 0);
            }
          }),
          EditorView.updateListener.of(update => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
            if (update.selectionSet || update.docChanged) {
              const {from,to}=update.state.selection.main;
              if (from === to) {
                onSelectionRef.current?.(null);
              } else {
                const end = Math.min(to, from + 10_000);
                const startLine = update.state.doc.lineAt(from).number;
                const endLine = update.state.doc.lineAt(to).number;
                const coords = update.view.coordsAtPos(from);
                onSelectionRef.current?.({
                  text: update.state.sliceDoc(from, end), truncated: end < to, from, to: end,
                  lineRange: { start: startLine, end: endLine },
                  anchor: coords === null ? null : { x: coords.left, y: Math.max(12, coords.top - 48) }
                });
              }
            }
          })
        ]
      })
    });
    view.current = editor;
    const saveScroll = (): void => {
      if (editor.dom.getClientRects().length > 0) retainedScroll.current = editor.scrollSnapshot();
    };
    editor.scrollDOM.addEventListener('scroll', saveScroll, {passive: true});
    return () => {
      saveScroll();
      retainedState.current = editor.state;
      clearTimeout(compositionEndTimer.current);
      editor.scrollDOM.removeEventListener('scroll', saveScroll);
      view.current = null;
      editor.destroy();
    };
  }, [display]);

  useLayoutEffect(() => {
    const editor = view.current;
    if (editor !== null && editor.state.doc.toString() !== value) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
    }
  }, [value, display]);
  useLayoutEffect(() => {
    view.current?.dispatch({ effects: readOnlyConfig.current.reconfigure(EditorState.readOnly.of(readOnly)) });
  }, [readOnly, display]);

  useEffect(() => {
    const editor = view.current;
    if (editor === null || focusLine == null || appliedFocus.current === focusLine.nonce) return;
    appliedFocus.current = focusLine.nonce;
    const line = editor.state.doc.line(Math.max(1, Math.min(focusLine.line, editor.state.doc.lines)));
    editor.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
    editor.focus();
  }, [focusLine, display]);

  useEffect(() => {
    const editor = view.current;
    if (editor === null || replacement === null || appliedReplacement.current === replacement.nonce) return;
    // Rejected proposals are consumed too; returning to an old document must
    // never revive an already refused application.
    appliedReplacement.current = replacement.nonce;
    if (editor.state.readOnly || editor.state.doc.toString() !== replacement.expectedDocument ||
        editor.state.selection.main.from !== replacement.from || editor.state.selection.main.to !== replacement.to ||
        replacement.nonce < 1 || replacement.from < 0 || replacement.to < replacement.from || replacement.to > editor.state.doc.length) return;
    editor.dispatch({ changes: { from: replacement.from, to: replacement.to, insert: replacement.text }, selection: { anchor: replacement.from + replacement.text.length } });
  }, [replacement, display]);

  useEffect(() => { view.current?.requestMeasure(); }, [preferences.codeSize]);

  return <div ref={host} className="min-h-0 min-w-0 flex-1 overflow-hidden" data-testid="latex-source-editor" />;
}
