import type {WikiDependency, WikiPaperKnowledgeSource, WikiSection} from '../../../shared/schemas/research-wiki-pages';
import {scientificWikiUnknownSection} from './wiki-scientific-synthesis';

export const scientificTopicTargets = [
  {id: 'scientific:overview', title: 'Overview · 概览'},
  {id: 'scientific:concepts', title: 'Core Concepts · 核心概念'},
  {id: 'scientific:methods', title: 'Related Methods · 相关方法'},
  {id: 'scientific:mathematical', title: 'Mathematical Formulation · 数学表述'},
  {id: 'scientific:experiments', title: 'Experimental Evidence · 实验证据'},
  {id: 'scientific:datasets', title: 'Related Datasets · 相关数据集'},
  {id: 'scientific:comparison', title: 'Research Comparison · 研究比较'},
  {id: 'scientific:questions', title: 'Open Questions · 开放问题'},
  {id: 'scientific:papers', title: 'Source Papers · 来源论文'}
] as const;

/** Pending sections are filled through the existing bounded, source-verified assistant synthesis. */
export function scientificTopicSections(sources: WikiPaperKnowledgeSource[], dependencies: WikiDependency[]): WikiSection[] {
  return scientificTopicTargets.map(target => ({
    ...scientificWikiUnknownSection(target, sources), owner: 'assistant', status: 'stale', dependencies
  }));
}

export function scientificComparisonSections(sources: WikiPaperKnowledgeSource[], dependencies: WikiDependency[]): WikiSection[] {
  return scientificTopicSections(sources, dependencies).filter(section =>
    ['scientific:methods', 'scientific:experiments', 'scientific:comparison'].includes(section.id));
}
