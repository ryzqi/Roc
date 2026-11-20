import type {PaperChunk} from '../../../shared/schemas/research-paper-ir';
import {isPageMargin, type ResearchBlockReading} from '../../../shared/schemas/research-document-reading';
import {buildPaperStructure} from './paper-structure';
import {assertPaperStructure, type PaperStructure} from '../../../shared/schemas/research-paper-structure';
import {assertPaperTableBlock, type NormalizedPaperTable} from '../../../shared/schemas/research-paper-table';
import {assertPaperEquationBlock, type PaperEquation} from '../../../shared/schemas/research-paper-equation';
import {assertPaperVisualBlock, assertPaperVisualEvidence, type PaperVisual} from '../../../shared/schemas/research-paper-visual';

/** Identity of the existing block-derived IR; independent from parser and chunk versions. */
export const paperIrVersion = 'roc-paper-ir/1-structure-1-table-1-equation-1-visual-1';
export type PaperIdentity = Pick<PaperChunk, 'paperId' | 'parseId' | 'sourceHash'>;
export type PaperBlock = {id: string; text: string; locator: string; kind: PaperChunk['blockKind']; label?: string;
  reading?: ResearchBlockReading; table?: NormalizedPaperTable; equation?: PaperEquation; visual?: PaperVisual;
  locations?: Omit<NormalizedPaperTable['source'], 'locator'>[]};

export function scientificRole(section: string | null): PaperChunk['semanticRole'] {
  const text = section ?? '';
  if (/ablation|消融/iu.test(text)) return 'ablation';
  if (/limitations?|future work|局限|限制|未来工作/iu.test(text)) return 'limitations';
  if (/experimental (settings?|setup)|training|implementation|datasets?|baselines?|实验设置|训练|数据集|基线/iu.test(text)) return 'experimental_setup';
  if (/results?|evaluation|experiments?|结果|评估|实验/iu.test(text)) return 'results';
  if (/method|model|architect|algorithm|approach|方法|模型|架构|算法/iu.test(text)) return 'method';
  if (/contributions?|贡献/iu.test(text)) return 'contribution';
  if (/abstract|摘要/iu.test(text)) return 'abstract';
  if (/introduction|background|problem|引言|背景|问题/iu.test(text)) return 'problem';
  return 'unknown';
}

export function paperHeading(text: string): {title: string; level: number} | null {
  const line = text.trim();
  const numbered = line.match(/^(\d+(?:\.\d+)*)(?:\.|\s)\s*(.{2,160})$/u);
  if (numbered) return {title: numbered[2]!, level: Math.min(6, numbered[1]!.split('.').length)};
  if (line.length < 160 && scientificRole(line) !== 'unknown' &&
      /^(abstract|introduction|background|method(?:s|ology)?|(?:proposed )?approach|experiments?|experimental (?:setup|settings?)|results?(?: and discussion)?|evaluation|ablation(?: study| studies)?|limitations?|contributions?|conclusion|摘要|引言|方法|实验(?:设置)?|结果|消融|局限性?)$/iu.test(line)) {
    return {title: line, level: 1};
  }
  return null;
}

/** Derived annotations retain parser block IDs and exact original text/locators. */
export function paperBlocks(blocks: readonly PaperBlock[], identity: PaperIdentity, suppliedStructure?: PaperStructure) {
  blocks.forEach(assertPaperTableBlock);
  blocks.forEach(assertPaperEquationBlock);
  blocks.forEach(assertPaperVisualBlock);
  assertPaperVisualEvidence(blocks.map(block => ({...block, locations: block.locations ?? []})));
  const structure = suppliedStructure ?? buildPaperStructure(blocks);
  assertPaperStructure(structure, blocks);
  const annotations = new Map(structure.blocks.map(block => [block.blockId, block]));
  const sections = new Map(structure.sections.map(section => [section.id, section]));
  const blockIds = new Set(blocks.map(block => block.id));
  return blocks.filter(block => block.text.trim() || block.table || block.equation || block.visual).map((block, index, source) => {
    const marginal = isPageMargin(block.reading?.role);
    const annotation = annotations.get(block.id)!;
    const sectionPath = marginal ? [] : annotation.sectionIds.map(id => sections.get(id)!.title.trim().slice(0, 2000));
    const relatedBlockIds = [...new Set([...[source[index - 1], source[index + 1]]
      .filter((other): other is PaperBlock => other !== undefined &&
        (['table', 'figure', 'formula'].includes(block.kind) || ['table', 'figure', 'formula'].includes(other.kind)))
      .map(other => other.id), ...[block.reading?.continuesFrom, block.reading?.continuesTo]
      .filter((id): id is string => typeof id === 'string' && blockIds.has(id))])];
    const semantic: PaperChunk = {...identity, blockId: block.id, sectionPath,
      semanticRole: scientificRole(sectionPath.join(' / ')), blockKind: block.kind, relatedBlockIds,
      sectionIds: annotation.sectionIds, scientific: annotation.semantic,
      ...(block.table ? {table: block.table} : {}), ...(block.equation ? {equation: block.equation} : {}),
      ...(block.visual ? {visual: block.visual} : {})};
    return {content: block.text, locator: block.locator, section: sectionPath.join(' / ') || null, semantic};
  });
}
