import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  normalizeBibliographyRecords,
  readBibtex,
  readCsl,
  readResearchBibliography,
  writeBibliography,
  writeResearchBibliography
} from '../../../../src/main/plugins/research/bibliography';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('research bibliography', () => {
  it('keeps protected titles, custom fields and institutional authors', () => {
    const text = '@string{journalname={A Journal}}\n@article{doe2026,title={A {DNA} study},author={Doe, Jane and {Research Group}},journal=journalname,year={2026},doi={10.1234/X},custom={keep me}}';
    const entries = readBibtex(text);
    expect(entries[0].title).toBe('A DNA study');
    expect(entries[0].authors).toEqual(['Jane Doe', 'Research Group']);
    expect(entries[0].fields.title).toBe('A {DNA} study');
    const restored = readBibtex(writeBibliography(entries, 'biblatex'))[0];
    expect(restored.fields.journaltitle).toBe('A Journal');
    expect(restored.fields.custom).toBe('keep me');
    expect(JSON.parse(writeBibliography(entries, 'csl-json'))[0].author).toEqual([
      { given: 'Jane', family: 'Doe' },
      { literal: 'Research Group' }
    ]);
  });

  it('round-trips Zotero CSL dates, unicode and extra fields', () => {
    const source = [{
      id: 'source', type: 'article-journal', title: '研究 A & B', DOI: '10.1234/x',
      author: [{ family: 'Doe', given: 'Jane' }, { literal: 'Research Group' }],
      issued: { 'date-parts': [[2026, 9, 11]] }, 'container-title': 'A Journal', 'custom-extra': 'preserved'
    }];
    const entries = readCsl(JSON.stringify(source));
    expect(entries[0].title).toBe('研究 A & B');
    expect(JSON.parse(writeBibliography(entries, 'csl-json'))[0]).toEqual(source[0]);
    expect(readBibtex(writeBibliography(entries, 'bibtex'))[0].title).toBe('研究 A & B');
  });

  it('reports bad blocks and required metadata instead of partial import', () => {
    expect(() => readBibtex('@article{broken,title={not closed}')).toThrow(/parse_failed/);
    expect(() => readBibtex('@article{key,author={Doe, Jane}}')).toThrow(/title_required/);
    expect(() => readCsl('[{"id":"key","title":"Title"}]')).toThrow(/csl_type_required/);
  });

  it('export rejects duplicate citation keys and conflicting journals', () => {
    const entry = readBibtex('@article{key,title={Title}}')[0];
    expect(() => writeBibliography([entry, entry], 'bibtex')).toThrow(/citation_key_duplicate/);
    const conflict = readBibtex('@article{key,title={Title},journal={Legacy Journal},journaltitle={Primary Journal}}');
    for (const format of ['bibtex', 'biblatex', 'csl-json'] as const) {
      expect(() => writeBibliography(conflict, format)).toThrow(/journal_conflict/);
    }
  });

  it('empty journal aliases do not replace the retained title', () => {
    for (const fields of ['journal={},journaltitle={Primary}', 'journal={Primary},journaltitle={ }', 'journal={ },journaltitle={Primary}']) {
      const entries = readBibtex(`@article{key,title={Title},${fields}}`);
      for (const format of ['bibtex', 'biblatex', 'csl-json'] as const) {
        const output = writeBibliography(entries, format);
        if (format === 'csl-json') {
          expect(JSON.parse(output)[0]['container-title']).toBe('Primary');
        } else {
          const key = format === 'bibtex' ? 'journal' : 'journaltitle';
          expect(readBibtex(output)[0].fields[key]).toBe('Primary');
        }
      }
    }
  });

  it('converts chapters with book title, editors and edition', () => {
    const source = [{
      id: 'chapter', type: 'chapter', title: 'A chapter', 'container-title': 'A book', edition: '2',
      editor: [{ given: 'Jane', family: 'Doe' }], translator: [{ literal: 'Research Group' }]
    }];
    const entries = readCsl(JSON.stringify(source));
    expect(entries[0].fields.booktitle).toBe('A book');
    const restored = readBibtex(writeBibliography(entries, 'bibtex'));
    expect(JSON.parse(writeBibliography(restored, 'csl-json'))).toEqual(source);
  });

  it('keeps percent-encoded URLs and decodes only TeX URI escapes', () => {
    const source = [{ id: 'uri', type: 'article-journal', title: 'Links', URL: 'https://example.org/a%20b?x=1&y=2', DOI: '10.1234/a_b' }];
    const entries = readCsl(JSON.stringify(source));
    expect(entries[0].url).toBe(source[0].URL);
    expect(JSON.parse(writeBibliography(entries, 'csl-json'))[0].URL).toBe(source[0].URL);
    const parsed = readBibtex('@misc{escaped,title={Links},url={\\url{https://example.org/a\\_b?q=x\\&y=2}},doi={10.1234/a\\_b}}')[0];
    expect(parsed.url).toBe('https://example.org/a_b?q=x&y=2');
    expect(parsed.doi).toBe('10.1234/a_b');
  });

  it('preserves preamble and parses names with particles', () => {
    const text = '@preamble{"\\\\newcommand{\\\\x}{X}"}\n@book{book,title={A book},author={von Neumann, John},year={1950}}';
    const entries = readBibtex('@preamble{"\\newcommand{\\x}{X}"}\n@book{book,title={A book},author={von Neumann, John},year={1950}}');
    const restored = readBibtex(writeBibliography(entries, 'bibtex'))[0];
    expect(restored.preambles).toEqual(entries[0].preambles);
    expect(JSON.parse(writeBibliography(entries, 'csl-json'))[0].author).toEqual([
      { given: 'John', family: 'Neumann', 'non-dropping-particle': 'von' }
    ]);
    void text;
  });

  it('updates both CSL identifiers after a citation-key edit', () => {
    const entries = readCsl('[{"id":"old","citation-key":"old","type":"article-journal","title":"Title"}]');
    entries[0].citationKey = 'new-key';
    const result = JSON.parse(writeBibliography(entries, 'csl-json'))[0];
    expect(result.id).toBe('new-key');
    expect(result['citation-key']).toBe('new-key');
    expect(readCsl(JSON.stringify([result]))[0].citationKey).toBe('new-key');
  });

  it('export uses retained dates after merging CSL metadata', () => {
    const entries = readCsl('[{"id":"key","type":"article-journal","title":"Title","issued":{"date-parts":[[2009,1]]}}]');
    entries[0].publishedYear = 2026;
    Object.assign(entries[0].fields, { date: '2026-09-11', year: '2026' });
    expect(JSON.parse(writeBibliography(entries, 'csl-json'))[0].issued).toEqual({ 'date-parts': [[2026, 9, 11]] });
  });

  it('preserves CSL author extensions and date qualifiers', () => {
    const source = [{
      id: 'key', type: 'article-journal', title: 'Title',
      author: [{ family: 'Doe', given: 'Jane', ORCID: 'https://orcid.org/0000-0000-0000-0000' }],
      issued: { 'date-parts': [[2026]], circa: true }
    }];
    expect(JSON.parse(writeBibliography(readCsl(JSON.stringify(source)), 'csl-json'))).toEqual(source);
  });

  it('rejects invalid CSL dates and unknown types', () => {
    for (const issued of [[], '2026', { 'date-parts': [] }, { 'date-parts': [[2026, true]] }, { 'date-parts': [[2026, 13]] },
      { 'date-parts': [[2026, 2, 30]] }, { 'date-parts': [[2026, 1], ['bad']] }, { 'date-parts': [[2026, 1, 1, 9]] }]) {
      expect(() => readCsl(JSON.stringify([{ id: 'key', type: 'article-journal', title: 'Title', issued }]))).toThrow(/csl_date_invalid/);
    }
    expect(() => readCsl('[{"id":"key","type":"invented-type","title":"Title"}]')).toThrow(/csl_type_unsupported/);
  });

  it('preserves full dates, ranges, literals and BibTeX months', () => {
    const entry = readBibtex('@article{key,title={Title},date={2026-09-11}}')[0];
    expect(JSON.parse(writeBibliography([entry], 'csl-json'))[0].issued).toEqual({ 'date-parts': [[2026, 9, 11]] });
    const restored = readCsl(JSON.stringify([JSON.parse(writeBibliography([entry], 'csl-json'))[0]]))[0];
    expect(restored.fields.date).toBe('2026-09-11');
    for (const date of [{ 'date-parts': [[2026, 9, 11], [2026, 9, 13]] }, { literal: 'in press' }]) {
      const source = [{ id: 'range', title: 'Dates', type: 'article-journal', issued: date }];
      const bib = writeBibliography(readCsl(JSON.stringify(source)), 'biblatex');
      expect(JSON.parse(writeBibliography(readBibtex(bib), 'csl-json'))[0].issued).toEqual(date);
    }
    expect(JSON.parse(writeBibliography(readBibtex('@article{key,title={Dates},year={2026},month=sep,day={11}}'), 'csl-json'))[0].issued)
      .toEqual({ 'date-parts': [[2026, 9, 11]] });
  });

  it('normalizing search metadata preserves atomic author names', () => {
    const authors = ['Jane Doe', 'Research and Development Group'];
    expect(normalizeBibliographyRecords([{
      citationKey: 'key',
      metadata: { title: 'Title', authors, doi: null, url: null, abstract: null, publishedYear: null }
    }])[0].authors).toEqual(authors);
  });

  it('reads and writes bibliography through project-scoped job outputs', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-bibliography-job-')));
    roots.push(root);
    const source = join(root, 'references.bib');
    await writeFile(source, '@article{key,title={A {DNA} study},year={2026}}');
    const parsed = await readResearchBibliography({
      projectRoot: root, sourcePath: source, outputDir: join(root, 'read'), format: 'bibtex'
    });
    const data = join(root, 'entries.json');
    await writeFile(data, JSON.stringify(parsed.entries));
    const result = await writeResearchBibliography({
      projectRoot: root, sourcePath: data, outputDir: join(root, 'write'), format: 'csl-json'
    });
    expect(JSON.parse(result.content)[0].title).toBe('A DNA study');
    expect(await readFile(join(root, 'write/references.json'), 'utf8')).toBe(result.content);
  });
});
