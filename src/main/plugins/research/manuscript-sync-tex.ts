import {escapeLatex} from './latex-source';

export type ManuscriptWorkFileParagraph = {anchor: string | null; text: string; citationKeys: string[]};
export type ManuscriptWorkFileSection = {title: string; paragraphs: ManuscriptWorkFileParagraph[]};

const literal = new Map([
  ['\\textbackslash{}', '\\'], ['\\textasciitilde{}', '~'], ['\\textasciicircum{}', '^'],
  ...[...'{}%&#_$'].map(character => [`\\${character}`, character] as const)
]);

function plainText(tex: string, line: number): string {
  const value = tex.replace(/\\(?:textbackslash\{\}|textasciitilde\{\}|textasciicircum\{\}|[{}%&#_$])/gu, value => literal.get(value)!);
  if (!value || escapeLatex(value) !== tex) throw new Error(`第 ${line} 行含无法同步的 TeX 语法。`);
  return value;
}

export function renderManuscriptWorkFile(sections: ManuscriptWorkFileSection[], bibliographyName: string): string {
  const body = sections.map(section => [
    `\\section{${escapeLatex(section.title)}}`,
    ...section.paragraphs.map(({anchor, text, citationKeys}) => [
      `% roc-claim ${anchor}`,
      `${escapeLatex(text)}${citationKeys.length ? `\\cite{${citationKeys.join(',')}}` : ''}`
    ].join('\n'))
  ].join('\n\n')).join('\n\n');
  return `\\documentclass{article}\n\\begin{document}\n\n${body}\n\n\\bibliographystyle{plain}\n\\bibliography{${bibliographyName}}\n\\end{document}\n`;
}

/** Read the plain, single-file subset. TeX commands outside this grammar are never treated as prose. */
export function parseManuscriptWorkFile(source: string, bibliographyName: string): ManuscriptWorkFileSection[] {
  const sections: ManuscriptWorkFileSection[] = [];
  let section: ManuscriptWorkFileSection | undefined;
  let phase: 'preamble' | 'body' | 'bibliography' | 'end' = 'preamble';
  let paragraph: string[] = [], anchor: string | null = null, start = 1;
  const flush = (): void => {
    if (!paragraph.length) return;
    if (section === undefined) throw new Error(`第 ${start} 行的段落缺少小节标题。`);
    const text = paragraph.join('\n').trim();
    const citation = /(?<!\\)\\cite\{([^{}]*)\}$/u.exec(text);
    const keys = citation === null ? [] : citation[1].split(',').map(key => key.trim());
    if (keys.some(key => !/^[a-z0-9_.:+/-]+$/iu.test(key)) || new Set(keys).size !== keys.length) {
      throw new Error(`第 ${start} 行的引用键无效或重复。`);
    }
    const value = plainText(citation === null ? text : text.slice(0, citation.index).trimEnd(), start);
    if (value.length > 20_000) throw new Error(`第 ${start} 行的段落超过 20000 个字符。`);
    section.paragraphs.push({anchor, text: value, citationKeys: keys});
    paragraph = [];
    anchor = null;
  };
  for (const [index, raw] of source.split(/\r?\n/u).entries()) {
    const line = raw.trim();
    const number = index + 1;
    if (!line) {flush(); continue;}
    const marker = /^% (?:roc-claim ([a-z0-9_-]+)|claim: ([a-z0-9_-]+); version: [1-9][0-9]*)$/iu.exec(line);
    if (marker !== null) {
      flush();
      if (phase !== 'body' || section === undefined || anchor !== null) throw new Error(`第 ${number} 行的段落锚点位置无效。`);
      anchor = marker[1] ?? marker[2];
      continue;
    }
    if (line.startsWith('%')) continue;
    if (phase === 'preamble') {
      if (/^\\documentclass(?:\[[a-z0-9,= -]*\])?\{[a-z0-9_-]+\}$/iu.test(line)) continue;
      if (line === '\\begin{document}') {phase = 'body'; continue;}
    }
    if (phase === 'body') {
      const heading = /^\\section\{(.*)\}$/u.exec(line);
      if (heading !== null) {
        flush();
        if (anchor !== null) throw new Error(`第 ${number} 行前的锚点缺少段落。`);
        const title = plainText(heading[1], number);
        if (title.trim() !== title || title.length > 300) throw new Error(`第 ${number} 行的小节标题无效。`);
        section = {title, paragraphs: []};
        sections.push(section);
        continue;
      }
      if (/^\\bibliographystyle\{[a-z0-9_-]+\}$/iu.test(line)) {flush(); continue;}
      if (line === `\\bibliography{${bibliographyName}}`) {
        flush();
        phase = 'bibliography';
        continue;
      }
      if (line.startsWith('\\') && ![...literal.keys()].some(value => line.startsWith(value))) {
        throw new Error(`第 ${number} 行含无法同步的 TeX 命令。`);
      }
      if (!paragraph.length) start = number;
      paragraph.push(line);
      continue;
    }
    if (phase === 'bibliography' && line === '\\end{document}') {phase = 'end'; continue;}
    throw new Error(`第 ${number} 行含无法同步的 TeX 结构。`);
  }
  if (phase !== 'end' || anchor !== null || sections.length === 0 || sections.some(section => !section.paragraphs.length)) {
    throw new Error('工作稿需包含正文、小节、段落和所选 BibTeX 文件。');
  }
  return sections;
}
