import type {PaperChunk} from '../../../shared/schemas/research-paper-ir';

export type PaperIdentity = Pick<PaperChunk, 'paperId' | 'parseId' | 'sourceHash'>;
export type PaperBlock = {id: string; text: string; locator: string; kind: PaperChunk['blockKind']; label?: string};

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
export function paperBlocks(blocks: readonly PaperBlock[], identity: PaperIdentity) {
  const hierarchy: string[] = [];
  const setHeading = (title: string, level: number): void => {
    hierarchy.length = Math.min(hierarchy.length, level - 1);
    hierarchy[level - 1] = title.trim().slice(0, 2000);
  };
  return blocks.filter(block => block.text.trim()).map((block, index, source) => {
    if (block.kind === 'heading') {
      const heading = paperHeading(block.text);
      const htmlLevel = block.label?.match(/^h([1-6])$/iu)?.[1];
      const level = htmlLevel ? Number(htmlLevel) : heading?.level ?? 1;
      setHeading(block.text, level);
    }
    const sectionPath = hierarchy.filter(Boolean);
    const relatedBlockIds = [source[index - 1], source[index + 1]]
      .filter((other): other is PaperBlock => other !== undefined &&
        (['table', 'figure', 'formula'].includes(block.kind) || ['table', 'figure', 'formula'].includes(other.kind)))
      .map(other => other.id);
    const semantic: PaperChunk = {...identity, blockId: block.id, sectionPath,
      semanticRole: scientificRole(sectionPath.join(' / ')), blockKind: block.kind, relatedBlockIds};
    if (block.kind === 'paragraph') for (const line of block.text.split(/\r\n|\r|\n/u)) {
      const heading = paperHeading(line);
      if (heading) setHeading(line, heading.level);
    }
    return {content: block.text, locator: block.locator, section: sectionPath.join(' / ') || null, semantic};
  });
}
