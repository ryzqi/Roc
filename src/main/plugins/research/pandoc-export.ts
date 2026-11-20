import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {ResearchExportExecution, ResearchExportSources} from '../../../shared/schemas/research-exports';
import {researchCitationStyles} from '../../../shared/schemas/research-citation-style';
import {defaultTypstCitationStyle} from './typst-report';
import {createResearchDirectory, readResearchFile, researchContentHash} from './research-files';
import {type ExportToolchain, ResearchExportFiles, exportFileLimit} from './export-files';
import {assertPublicExportText} from './export-public-files';

// Claims are plain text in Roc. Never reinterpret TeX/HTML/Markdown as executable markup.
type Node = {t: string; c?: unknown};
const attr = ['', [], []];
const text = (value: string): Node[] => value.split(/(\s+)/u).filter(Boolean).map(part => /^\s+$/u.test(part) ? {t: 'Space'} : {t: 'Str', c: part});
export const conversionLimitations = [
  'Generated from approved sections, claims, citations and figure captions; imported TeX template layout is not converted.',
  'Claim content is plain text. Embedded TeX/Markdown math and table syntax remains literal; no equation/table semantics are inferred.',
  'Only verified PNG figure renditions are embedded. Check typography, pagination and bibliography in the target application.'
];

export function pandocDocument(sources: ResearchExportSources, title: string, images: ReadonlyMap<string, string>) {
  const claims = new Map(sources.claims.map(claim => [claim.id, claim]));
  const bibliography = new Set(sources.bibliography.map(entry => entry.citationKey));
  const claimText = (id: string): Node[] => {
    const claim = claims.get(id);
    if (!claim) throw new Error('research_claim_not_found');
    const keys = [...new Set(claim.evidenceIds.map(id => sources.citationKeys[id]))];
    if (keys.some(key => !key || !bibliography.has(key))) throw new Error('research_export_citation_unknown');
    return [...text(claim.content), ...(keys.length ? [{t: 'Space'}, {t: 'Cite', c: [keys.map(key => ({
      citationId: key, citationPrefix: [], citationSuffix: [], citationMode: {t: 'NormalCitation'}, citationNoteNum: 0, citationHash: 0
    })), []]}] : [])];
  };
  const blocks: Node[] = sources.manuscript.sections.flatMap((section, index) => [
    {t: 'Header', c: [1, [`section-${index + 1}`, [], []], text(section.title)]},
    ...section.claimIds.map(id => ({t: 'Para', c: claimText(id)}))
  ]);
  for (const figure of sources.figures) {
    const path = images.get(figure.id);
    if (!path) throw new Error('research_export_conversion_figure_png_required');
    const captions = sources.claims.filter(claim => claim.artifactId === figure.artifactId && claim.subjectType === 'figure');
    if (!captions.length) throw new Error('research_figure_evidence_required');
    blocks.push({t: 'Para', c: [{t: 'Image', c: [attr, text(figure.title), [path, '']]}]},
      {t: 'Para', c: captions.flatMap((claim, index) => [...(index ? [{t: 'Space'}] : []), ...claimText(claim.id)])});
  }
  return {'pandoc-api-version': [1, 23, 1], meta: {title: {t: 'MetaInlines', c: text(title)}}, blocks};
}

export async function buildPandocExports(input: {record: ResearchExportExecution; sources: ResearchExportSources;
  writer: ResearchExportFiles; tools: ExportToolchain; scratch: string; signal: AbortSignal; bibliography: string; language: 'zh' | 'en'}) {
  const {record, sources, writer, tools, signal} = input;
  const formats = record.request.conversionFormats ?? [];
  if (!formats.length) return;
  const directory = await createResearchDirectory(input.scratch, 'pandoc');
  const images = new Map<string, string>();
  const inputs = [];
  for (const figure of sources.figures) {
    const file = writer.list().find(file => file.path.startsWith('source/') && file.path.endsWith(`/figures/${figure.id}.png`));
    if (!file) throw new Error('research_export_conversion_figure_png_required');
    const bytes = await readResearchFile(writer.root, file.path, exportFileLimit);
    if (researchContentHash(bytes) !== file.sha256) throw new Error('research_export_snapshot_changed');
    const name = `figure-${images.size}.png`;
    await writeFile(join(directory, name), bytes, {flag: 'wx', mode: 0o400});
    images.set(figure.id, name); inputs.push({...file, conversionPath: name});
  }
  const ast = JSON.stringify(pandocDocument(sources, record.request.title, images));
  assertPublicExportText(ast);
  const style = record.request.reportCitationStyle ?? defaultTypstCitationStyle(input.language);
  const csl = await tools.typstStyle(researchCitationStyles[style].file);
  for (const [name, bytes] of [['document.json', ast], ['references.bib', input.bibliography], ['style.csl', csl]] as const) {
    await writeFile(join(directory, name), bytes, {flag: 'wx', mode: 0o400});
    await writer.write(`conversion/${name}`, bytes);
  }
  // Include reproducible local image inputs, not paths into the scratch directory.
  for (const file of inputs) await writer.copy(writer.root, file, `conversion/${file.conversionPath}`);
  const outputs = [];
  for (const format of formats) {
    signal.throwIfAborted();
    const result = await tools.convertDocument({rootPath: directory, jobDir: input.scratch, format, signal,
      admission: {projectId: record.projectId, priority: 'user'}});
    if (result.exitCode !== 0) throw new Error('research_export_conversion_failed');
    const bytes = await readResearchFile(directory, `paper.${format}`, exportFileLimit);
    if (format === 'docx' ? bytes.subarray(0, 2).toString() !== 'PK' : !bytes.toString('utf8').includes('<html')) throw new Error('research_export_conversion_invalid');
    outputs.push(await writer.write(`paper.${format}`, bytes));
  }
  await writer.write('conversion/manifest.json', JSON.stringify({schemaVersion: 1, converter: 'pandoc',
    toolchainHash: await tools.utilityIdentity(), sourceHash: record.sourceHash, astHash: researchContentHash(ast),
    style, styleHash: researchContentHash(csl), inputs, outputs, limitations: conversionLimitations}, null, 2));
}
