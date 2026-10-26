import { useEffect, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, drawSelection, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { search, searchKeymap } from '@codemirror/search';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { useContentPreferences } from '../app/use-content-preferences';
import { tags } from '@lezer/highlight';

const sourceHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.tagName], color: 'var(--syntax-keyword)' },
  { tag: [tags.string, tags.attributeName], color: 'var(--syntax-string)' },
  { tag: tags.comment, color: 'var(--syntax-comment)' },
  { tag: [tags.number, tags.atom], color: 'var(--syntax-number)' }
]);

const sourceTheme = EditorView.theme({
  '&': { height: '100%', color: 'var(--ink)', backgroundColor: 'var(--bg)' },
  '&.cm-focused': { outline: '2px solid var(--accent)', outlineOffset: '-2px' },
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
export function SourceEditor({ value, readOnly, onChange }: {
  value: string;
  readOnly: boolean;
  onChange: (value: string) => void;
}): React.JSX.Element {
  const { preferences } = useContentPreferences();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const readOnlyConfig = useRef(new Compartment());
  const initial = useRef(value);

  useEffect(() => {
    if (host.current === null) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initial.current,
        extensions: [
          lineNumbers(), history(), drawSelection(), highlightActiveLine(),
          StreamLanguage.define(stex), syntaxHighlighting(sourceHighlight), sourceTheme,
          search({ top: true }), keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          EditorView.contentAttributes.of({ 'aria-label': '文稿源码', 'data-testid': 'production-latex-content', spellcheck: 'false' }),
          readOnlyConfig.current.of(EditorState.readOnly.of(false)),
          EditorView.updateListener.of(update => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          })
        ]
      })
    });
    view.current = editor;
    return () => { view.current = null; editor.destroy(); };
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (editor !== null && editor.state.doc.toString() !== value) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
    }
  }, [value]);
  useEffect(() => {
    view.current?.dispatch({ effects: readOnlyConfig.current.reconfigure(EditorState.readOnly.of(readOnly)) });
  }, [readOnly]);

  useEffect(() => { view.current?.requestMeasure(); }, [preferences.codeSize]);

  return <div ref={host} className="min-h-0 min-w-0 flex-1 overflow-hidden" data-testid="latex-source-editor" />;
}
