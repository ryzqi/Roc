import type {QueryRoute} from '../../../shared/schemas/research-reranker';

export function routeScientificQuery(query: string, documentId: string | null): QueryRoute {
  const intent = /比较|区别|对比|哪些论文|哪些研究|compare|comparison|versus|\bvs\b/iu.test(query) ? 'comparison'
    : /反对|矛盾|冲突|否定|contradict|refut|against/iu.test(query) ? 'dispute'
    : /表\s*\d|指标|结果|消融|准确率|成本|预算|table|result|ablation|accuracy|metric|cost|budget|\bF1\b/iu.test(query) ? 'results'
    : /方法|模型|架构|算法|method|model|architect|algorithm/iu.test(query) ? 'method'
    : /研究方向|综述|概览|领域|overview|survey|research direction/iu.test(query) ? 'overview' : 'general';
  return {intent, documentId, diversify: documentId === null && ['comparison', 'dispute', 'overview'].includes(intent)};
}

export function selectDiverse<T extends {documentId: string; semantic?: {paperId: string} | null}>(ordered: T[], limit: number, diversify: boolean): T[] {
  if (!diversify) return ordered.slice(0, limit);
  const selected: T[] = [], counts = new Map<string, number>();
  for (const item of ordered) {
    const paperId = item.semantic?.paperId ?? item.documentId;
    if ((counts.get(paperId) ?? 0) >= 2) continue;
    selected.push(item); counts.set(paperId, (counts.get(paperId) ?? 0) + 1);
    if (selected.length === limit) return selected;
  }
  return [...selected, ...ordered.filter(item => !selected.includes(item))].slice(0, limit);
}
