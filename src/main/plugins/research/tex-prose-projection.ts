import type {ProseBundle} from './prose-projection';

/** Mask syntax without changing line/column offsets. Never execute TeX or expand user macros. */
export function projectTexProse(source: string): {projection: ProseBundle; limitations: string[]} {
  const output = source.split('');
  const limitations = new Set<string>();
  const mask = (start: number, end: number): void => {
    for (let i = start; i < end; i++) if (output[i] !== '\n' && output[i] !== '\r') output[i] = ' ';
  };
  const group = (start: number): number => {
    const close = source[start] === '[' ? ']' : '}';
    let depth = 1, i = start + 1;
    for (; i < source.length; i++) {
      if (source[i] === '\\') { i++; continue; }
      if (source[i] === source[start]) depth++;
      if (source[i] === close && --depth === 0) return i + 1;
    }
    limitations.add('unclosed_group'); return source.length;
  };
  const prose = new Set(['section', 'subsection', 'subsubsection', 'paragraph', 'title', 'caption', 'textbf', 'textit', 'emph', 'textrm', 'textsf', 'footnote']);
  const silent = new Set(['cite', 'citep', 'citet', 'autocite', 'parencite', 'ref', 'eqref', 'label', 'url', 'bibliography', 'bibliographystyle',
    'documentclass', 'usepackage', 'includegraphics', 'addbibresource', 'maketitle', 'tableofcontents', 'item', 'par', 'noindent']);
  for (let i = 0; i < source.length;) {
    const start = i;
    if (source[i] === '%') { const end = source.indexOf('\n', i); i = end === -1 ? source.length : end; mask(start, i); continue; }
    if (source[i] === '$') {
      const delimiter = source[i + 1] === '$' ? '$$' : '$';
      i += delimiter.length;
      while (i < source.length && !(source.startsWith(delimiter, i) && source[i - 1] !== '\\')) i++;
      if (i === source.length) limitations.add('unclosed_math');
      i = Math.min(source.length, i + delimiter.length); mask(start, i); continue;
    }
    if (source[i] !== '\\') { if (source[i] === '{' || source[i] === '}') mask(i, i + 1); i++; continue; }
    const command = /^\\([A-Za-z]+)\*?/u.exec(source.slice(i));
    if (command === null) {
      if (source[i + 1] === '(' || source[i + 1] === '[') {
        const end = source.indexOf(source[i + 1] === '(' ? '\\)' : '\\]', i + 2);
        if (end < 0) limitations.add('unclosed_math');
        i = end < 0 ? source.length : end + 2; mask(start, i);
      } else { mask(i, i + 1); i += 2; }
      continue;
    }
    const name = command[1]; i += command[0].length; mask(start, i);
    if (name === 'verb') {
      const delimiter = source[i], end = delimiter === undefined ? -1 : source.indexOf(delimiter, i + 1);
      i = end < 0 ? source.length : end + 1; mask(start, i); continue;
    }
    while (/\s/u.test(source[i] ?? '') && i < source.length) i++;
    if (name === 'begin' || name === 'end') {
      if (source[i] !== '{') { limitations.add('invalid_environment'); continue; }
      const end = group(i), environment = source.slice(i + 1, end - 1); mask(i, end); i = end;
      if (name === 'begin' && !['document', 'abstract', 'itemize', 'enumerate', 'quote', 'quotation', 'figure', 'table', 'center'].includes(environment)) {
        const closing = `\\end{${environment}}`, stop = source.indexOf(closing, i);
        i = stop < 0 ? source.length : stop + closing.length; mask(start, i);
        limitations.add(`environment_omitted:${environment}`);
      }
      continue;
    }
    if (prose.has(name)) {
      if (source[i] === '[') { const end = group(i); mask(i, end); i = end; }
      continue;
    }
    if (!silent.has(name)) limitations.add(`macro_not_expanded:${name}`);
    // Non-prose commands and arguments are omitted, including dynamic include paths.
    while (source[i] === '[' || source[i] === '{') {
      const end = group(i); mask(i, end); i = end;
      while (/\s/u.test(source[i] ?? '') && i < source.length) i++;
    }
  }
  return {projection: {units: [{path: 'sections/000.md', content: output.join(''), sectionIndex: 0, sectionTitle: '', segments: []}], claimIds: []},
    limitations: ['single_file_only_no_macro_expansion', ...limitations]};
}
