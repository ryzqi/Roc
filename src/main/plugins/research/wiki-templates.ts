import type {WikiSearchFilters, WikiSummary, WikiTemplate} from '../../../shared/schemas/research-wiki-pages';

export function wikiClassification(kind: WikiSummary['kind'], template?: WikiTemplate): {
  template: WikiTemplate; layer: 'L1' | 'L2' | 'L3'
} {
  const selected = kind === 'source' ? 'paper_source' : template ?? 'research_synthesis';
  return {template: selected, layer: selected === 'paper_source' ? 'L1' : selected === 'research_synthesis' ? 'L3' : 'L2'};
}

export function wikiMatchesFilters(page: Pick<WikiSummary, 'kind' | 'template'>, filters: WikiSearchFilters): boolean {
  const classification = wikiClassification(page.kind, page.template);
  return (!filters.kinds || filters.kinds.includes(page.kind)) &&
    (!filters.layers || filters.layers.includes(classification.layer)) &&
    (!filters.templates || filters.templates.includes(classification.template));
}

/** Templates only select section roles; all facts remain in their original publication. */
export const wikiTemplateSections: Partial<Record<WikiTemplate, readonly string[]>> = {
  concept: ['concepts', 'mathematical', 'methods', 'questions', 'papers'],
  method: ['overview', 'methods', 'mathematical', 'experiments', 'questions', 'papers'],
  equation: ['mathematical', 'concepts', 'methods', 'questions', 'papers'],
  algorithm: ['methods', 'mathematical', 'experiments', 'questions', 'papers'],
  dataset: ['datasets', 'experiments', 'comparison', 'questions', 'papers'],
  metric: ['concepts', 'mathematical', 'experiments', 'questions', 'papers'],
  protocol: ['methods', 'datasets', 'experiments', 'comparison', 'questions', 'papers']
};
