import type {ResearchClaim} from '../../../shared/types';
import type {WritingContextReceipt, WritingGroundingIssue} from '../../../shared/schemas/research-writing-context';
import type {ResearchRepository} from './repository';

export function writingIssue(code: WritingGroundingIssue['code'], message: string,
  location: Partial<Omit<WritingGroundingIssue, 'code' | 'message'>> = {}): WritingGroundingIssue {
  return {code, message, claimId: null, evidenceId: null, documentId: null, sectionIndex: null,
    sectionTitle: null, paragraphIndex: null, span: null, ...location};
}
// Preserve literal quantities; matching magnitude alone must not validate a different dimension.
// Keep an unrecognized Latin unit as a literal suffix, rather than silently accepting its bare number.
// Connectors are not units; whitespace products require an explicit exponent to avoid swallowing prose.
const unitAtom = String.raw`(?:%|％|(?!(?:and|or|to|of|in|on|at|for|with|without|is|are|was|were|versus|vs|respectively)\b)[\p{Script=Latin}µμ°]+|秒|毫秒|微秒|纳秒|分钟|小时|天|字节|瓦|焦耳)`;
const exponent = String.raw`(?:\^(?:\{[-+−]?\d+\}|[-+−]?\d+)|[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]+|[−-]\d+)`;
const unitPattern = String.raw`${unitAtom}${exponent}?(?:(?:[/·⋅*]\s*${unitAtom}${exponent}?)|(?:\s+${unitAtom}${exponent}))*(?![\p{Script=Latin}\p{N}_^⁺⁻])`;
const numberPattern = new RegExp(String.raw`(?:(?<![\p{L}\p{N}_])|(?<=[\p{Script=Han}]))[-+]?(?:\d+(?:[.,]\d+)*|\.\d+)(?:[eE][-+]?\d+)?(?:\s*${unitPattern})?`, 'gu');
const units = new RegExp(String.raw`\s*(${unitPattern})$`, 'u');
const compact = (value: string): string => value.toLocaleLowerCase().replace(/\s+/gu, '').replaceAll('％', '%');
const quantity = (value: string): string => value.replace(/\s+/gu, '').replaceAll('％', '%');

/** Host checks expose observable grounding gaps. They never infer scientific approval from matching text. */
export function checkWritingClaim(repository: ResearchRepository, claim: ResearchClaim, receipt: WritingContextReceipt,
  location: Partial<WritingGroundingIssue>): WritingGroundingIssue[] {
  const issues: WritingGroundingIssue[] = [];
  const add = (code: WritingGroundingIssue['code'], message: string,
    more: Partial<WritingGroundingIssue> = {}): void => {issues.push(writingIssue(code, message, {...location, ...more}));};
  const excerpts: string[] = [];
  if (!claim.evidenceIds.length) add('evidence_missing', '正式段落没有绑定原文证据。');
  for (const evidenceId of claim.evidenceIds) {
    try {
      const inspected = repository.evidence.inspectEvidence(evidenceId, claim.projectId);
      if (inspected.referenceStatus !== 'recorded') {add('source_stale', '段落引用的来源版本已失效。', {evidenceId}); continue;}
      if (!receipt.result.originalEvidenceIds.includes(evidenceId)) {
        add('evidence_missing', '该证据不在已校验写作上下文中，请更新上下文。', {evidenceId});
      }
      excerpts.push(inspected.evidence.excerpt);
    } catch (error) {add('evidence_missing', error instanceof Error ? error.message : '证据不可读取。', {evidenceId});}
  }
  try {repository.evidence.assertReviewedSupport(claim);}
  catch {add('human_review_required', '该段落尚未通过当前版本的人工支持关系审核。');}
  // Canonical table cells and unit headers can be absent from the parser's text projection.
  // Include only verified fact sources bound to one of this paragraph's original Evidence blocks.
  for (const fact of receipt.facts) for (const source of [...fact.evidence,
    ...fact.conditionEvidence.flatMap(condition => condition.evidence), ...fact.value?.unitEvidence ?? []]) {
    if (source.locator && receipt.bindings.some(binding => claim.evidenceIds.includes(binding.evidenceId) &&
      binding.source.locator.documentId === source.locator!.documentId && binding.source.locator.parseId === source.locator!.parseId &&
      binding.source.locator.blockId === source.locator!.blockId)) excerpts.push(source.quote);
  }
  const source = excerpts.join('\n'), sourceNumbers = [...source.matchAll(numberPattern)].map(match => quantity(match[0]));
  const factQuantity = (numeric: string, unit: string): boolean => receipt.facts.some(fact => fact.value &&
    compact(fact.value.raw) === numeric && fact.value.rawUnit && quantity(fact.value.rawUnit) === quantity(unit) &&
    fact.evidence.some(source => source.locator && receipt.bindings.some(binding => claim.evidenceIds.includes(binding.evidenceId) &&
      binding.source.documentId === source.identity.documentId && binding.source.locator.blockId === source.locator!.blockId)));
  const sourceQuantity = (numeric: string, unit: string): boolean => sourceNumbers.some(value =>
    compact(value.replace(units, '')) === numeric && quantity(value.match(units)?.[1] ?? '') === quantity(unit));
  for (const match of claim.content.matchAll(numberPattern)) {
    const literal = quantity(match[0]), unit = match[0].match(units)?.[1], numeric = compact(match[0].replace(units, ''));
    if (sourceNumbers.includes(literal)) continue;
    const matchingNumber = sourceNumbers.some(value => compact(value.replace(units, '')) === numeric);
    if (unit && factQuantity(numeric, unit)) continue;
    add(unit && matchingNumber ? 'unit_mismatch' : 'numeric_mismatch', unit && matchingNumber ?
      '原文中的数值未绑定相同单位，不能直接换算或补充单位。' : '段落数值未在所引证据中按原文出现。',
      {span: {start: match.index!, end: match.index! + match[0].length}});
  }
  if (typeof claim.experiment.value === 'number' || /(?:better|outperform|improv|superior|优于|提升|提高|超过)/iu.test(claim.content)) {
    for (const field of ['dataset', 'metric', 'baseline', 'conditions'] as const) {
      const value = claim.experiment[field];
      if (value === 'unknown' || !compact(source).includes(compact(value))) {
        add('conditions_missing', `比较所需的 ${field} 条件未知或没有对应原文。`);
      }
    }
    if (typeof claim.experiment.value === 'number' && !sourceNumbers.some(number =>
      compact(number.replace(units, '')) === String(claim.experiment.value))) add('numeric_mismatch', '主张结构化数值与原文不一致。');
    if (typeof claim.experiment.value === 'number' && (claim.experiment.unit === 'unknown' ||
      !sourceQuantity(String(claim.experiment.value), claim.experiment.unit) &&
      !factQuantity(String(claim.experiment.value), claim.experiment.unit))) {
      add('unit_mismatch', '主张结构化数值和单位没有共同绑定到原文数量或已验证事实。');
    }
  }
  const inference = /(?:therefore.{0,40}(?:proves?|guarantees?)|always|universally|因此.{0,20}(?:证明|必然)|始终|普遍适用)/iu.exec(claim.content);
  if (inference && !/(?:hypothes|conjectur|infer|may|推测|假设|可能|推断)/iu.test(claim.content)) {
    add('inference_as_fact', '推断或普遍性结论需要明确限定，并由人工审核其支持范围。',
      {span: {start: inference.index, end: inference.index + inference[0].length}});
  }
  const relations = repository.evidence.relations.list({projectId: claim.projectId, claimId: claim.id});
  for (const relation of relations.filter(relation => ['contradicts', 'qualifies'].includes(relation.kind) &&
    ['proposed', 'confirmed'].includes(relation.status))) {
    try {repository.evidence.relations.assertCurrent(relation);}
    catch {add('source_stale', '反面或限定关系的来源版本已改变。', {evidenceId: relation.evidenceId}); continue;}
    if (!claim.evidenceIds.includes(relation.evidenceId) || relation.condition && !compact(claim.content).includes(compact(relation.condition)) ||
      relation.kind === 'contradicts' && !/(?:however|although|contradict|limit|conflict|但|然而|相反|局限|冲突)/iu.test(claim.content)) {
      add('counterevidence_missing', '正文没有交代已记录的反面证据或适用条件。', {evidenceId: relation.evidenceId});
    }
  }
  const relevantLimitations = receipt.facts.filter(fact => fact.factType === 'limitation' &&
    receipt.bindings.some(binding => binding.source.documentId === fact.documentId && claim.evidenceIds.includes(binding.evidenceId)));
  if (relevantLimitations.length && !/(?:limit|however|although|only|局限|但|仅|条件)/iu.test(claim.content)) {
    add('counterevidence_missing', '来源论文有局限性事实，正文尚未交代其适用范围。');
  }
  return issues;
}
