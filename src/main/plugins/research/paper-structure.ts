import {isPageMargin, type ResearchBlockReading} from '../../../shared/schemas/research-document-reading';
import {assertPaperStructure, type PaperBlockSemantic, type PaperSection, type PaperStructure} from '../../../shared/schemas/research-paper-structure';

export const paperStructureVersion = 'roc-paper-structure/1';
export const paperSemanticRuleVersion = 'roc-paper-semantic-rules/1';
type Block = {id: string; text: string; kind: string; label?: string; reading?: ResearchBlockReading};

const categories: Array<[PaperSection['category'], RegExp]> = [
  ['abstract', /^(?:abstract|摘要)$/iu],
  ['introduction', /^(?:introduction|background|related work|引言|绪论|背景|相关工作)$/iu],
  ['method', /^(?:methods?|methodology|(?:proposed )?approach|model|architecture|algorithm|方法|模型|架构|算法)$/iu],
  ['experiments', /^(?:experiments?|experimental (?:setup|settings?)|evaluation|implementation(?: details)?|training|datasets?|baselines?|实验(?:设置)?|评估|训练|数据集|基线)$/iu],
  ['results', /^(?:results?(?: and discussion)?|findings|ablation(?: study| studies)?|结果|消融(?:实验)?)$/iu],
  ['discussion', /^(?:discussion|limitations?|future work|讨论|局限(?:性)?|限制|未来工作)$/iu],
  ['conclusion', /^(?:conclusions?(?: and future work)?|concluding remarks|结论|总结)$/iu],
  ['appendix', /^(?:appendi(?:x|ces)(?:\s+[A-Z0-9]+)?(?:\s*[:.：]\s*.+)?|附录(?:\s*[\p{L}\p{N}]+)?)$/iu],
  ['references', /^(?:references|bibliography|参考文献)$/iu]
];

export function paperSectionCategory(title: string): PaperSection['category'] {
  const name = title.trim().replace(/^#{1,6}\s+|^(?:\d+(?:\.\d+)*[.)]?|[A-Z](?:\.\d+)*[.)]?)\s+/u, '').trim();
  return categories.find(([, pattern]) => pattern.test(name))?.[0] ?? 'unknown';
}

/** A title shape only identifies structure; ordinary body references are not headings. */
export function scientificHeading(text: string): {level: number; category: PaperSection['category']} | null {
  const line = text.trim();
  if (!line || line.length > 160) return null;
  const markdown = line.match(/^(#{1,6})\s+\S/u);
  if (markdown) return {level: markdown[1]!.length, category: paperSectionCategory(line)};
  const numbered = line.match(/^(\d+(?:\.\d+)*|[A-Z](?:\.\d+)*)(?:[.)]?\s+)(.{2,150})$/u);
  if (numbered && (!/[.!?。！？]$/u.test(numbered[2]!) || paperSectionCategory(line) !== 'unknown') &&
      !/^[\p{Ll}]/u.test(numbered[2]!)) {
    return {level: Math.min(6, numbered[1]!.split('.').length), category: paperSectionCategory(line)};
  }
  const category = paperSectionCategory(line);
  return category === 'unknown' ? null : {level: 1, category};
}

const roleRules: Array<[PaperBlockSemantic['roles'][number]['role'], RegExp]> = [
  ['problem', /\b(?:we (?:address|investigate)|research question|the (?:problem|challenge) (?:is|of))\b|研究问题|解决.{0,12}问题/iu],
  ['contribution', /\b(?:our contributions?|we (?:propose|introduce|contribute))\b|本文(?:提出|贡献)|主要贡献/iu],
  ['method', /\b(?:our (?:method|model|approach)|we (?:compute|optimize|minimi[sz]e)|the (?:algorithm|architecture) (?:uses|consists))\b|我们(?:采用|设计)|本文方法|模型结构/iu],
  ['dataset', /\b(?:dataset|corpus|benchmark)\b|数据集|语料库/iu],
  ['metric', /\b(?:accuracy|precision|recall|f1(?:[- ]score)?|bleu|rouge|mean (?:squared|absolute) error)\b|准确率|精确率|召回率|评价指标/iu],
  ['experimental_setup', /\b(?:learning rate|batch size|training epochs?|train(?:ing)? split|experimental (?:setup|settings?)|we (?:train|evaluate) on)\b|学习率|批大小|训练轮数|实验设置/iu],
  ['result', /\b(?:outperforms?|achieves?|improves?)\b.{0,80}\b(?:\d+(?:\.\d+)?%?|accuracy|score|performance|baseline)\b|提升.{0,20}\d|实验结果(?:表明|显示)/iu],
  ['ablation', /\b(?:ablation|ablated|without the (?:component|module))\b|消融实验|去除.{0,12}模块/iu],
  ['limitation', /\b(?:our (?:method|model) (?:fails|cannot)|a limitation|limitations? of|we (?:cannot|do not) (?:handle|support))\b|局限性|无法处理|不适用于/iu]
];

export function scientificBlockSemantics(block: Block, path: readonly PaperSection[]): PaperBlockSemantic {
  const base = {version: 1 as const, classifierVersion: paperSemanticRuleVersion};
  if (isPageMargin(block.reading?.role) || block.kind === 'heading' || block.reading?.role === 'heading' ||
      block.reading?.role === 'caption' || !block.text.trim()) return {...base, status: 'not_applicable', roles: []};
  // Reference lists must not inherit experimental roles from cited paper titles.
  if (path.some(section => section.category === 'references')) return {...base, status: 'not_applicable', roles: []};
  const roles: PaperBlockSemantic['roles'] = roleRules.flatMap(([role, pattern]) => pattern.test(block.text)
    ? [{role, confidence: .85, source: 'rule' as const, signals: [`block_${role}_pattern`]}] : []);
  // Section priors apply only to sufficiently explicit terminal headings, not every broad chapter.
  const terminal = path.at(-1)?.title.trim().replace(/^(?:\d+(?:\.\d+)*[.)]?|[A-Z](?:\.\d+)*[.)]?)\s+/u, '');
  const prior: Array<[PaperBlockSemantic['roles'][number]['role'], RegExp]> = [
    ['method', /^(?:methods?|methodology|architecture|algorithm|方法|架构|算法)$/iu],
    ['dataset', /^(?:datasets?|corpus|数据集|语料库)$/iu],
    ['experimental_setup', /^(?:experimental (?:setup|settings?)|implementation details|training|实验设置|训练)$/iu],
    ['ablation', /^(?:ablation(?: study| studies)?|消融(?:实验)?)$/iu],
    ['limitation', /^(?:limitations?|局限(?:性)?)$/iu]
  ];
  for (const [role, pattern] of prior) if (terminal && pattern.test(terminal) && !roles.some(item => item.role === role)) {
    roles.push({role, confidence: .8, source: 'rule', signals: ['explicit_section_prior']});
  }
  return {...base, status: roles.length ? 'classified' : 'unknown', roles};
}

/** Flat nodes retain exact source titles and parent edges; no fabricated intermediate headings. */
export function buildPaperStructure(blocks: readonly Block[]): PaperStructure {
  const sections: PaperSection[] = [], annotations: PaperStructure['blocks'] = [], stack: PaperSection[] = [];
  for (const block of blocks) {
    const marginal = isPageMargin(block.reading?.role), caption = block.reading?.role === 'caption';
    const add = (start: number, end: number, heading: {level: number; category: PaperSection['category']}): void => {
      while (stack.length && stack.at(-1)!.level >= heading.level) stack.pop();
      const section: PaperSection = {id: `section:${block.id}:${start}`, blockId: block.id, start, end,
        title: block.text.slice(start, end), parentId: stack.at(-1)?.id ?? null, level: heading.level,
        category: heading.category, confidence: heading.category === 'unknown' ? .7 : .9, source: 'rule'};
      sections.push(section); stack.push(section);
    };
    if (!marginal && !caption && block.text.trim() && (block.kind === 'heading' || block.reading?.role === 'heading')) {
      const htmlLevel = block.label?.match(/^h([1-6])$/iu)?.[1], heading = scientificHeading(block.text);
      add(0, block.text.length, {level: htmlLevel ? Number(htmlLevel) : heading?.level ?? 1,
        category: /^(?:title|document_title|paper_title)$/iu.test(block.label ?? '') ? 'title'
          : heading?.category ?? paperSectionCategory(block.text)});
    }
    const path = marginal ? [] : [...stack];
    annotations.push({blockId: block.id, sectionIds: path.map(section => section.id),
      semantic: scientificBlockSemantics(block, path)});
    // Embedded native-page headings affect following blocks while their own source remains intact.
    if (!marginal && !caption && block.kind === 'paragraph' && block.reading?.role !== 'heading') {
      for (const match of block.text.matchAll(/[^\r\n]+/gu)) {
        const heading = scientificHeading(match[0]);
        if (heading) add(match.index, match.index + match[0].length, heading);
      }
    }
  }
  const result: PaperStructure = {version: 1, ruleVersion: paperStructureVersion, sections, blocks: annotations};
  assertPaperStructure(result, blocks);
  return result;
}
