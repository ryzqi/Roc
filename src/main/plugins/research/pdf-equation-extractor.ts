import {isPageMargin} from '../../../shared/schemas/research-document-reading';
import {paperEquationVersion, latexNormalizationVersion, normalizePaperLatex, latexHasBalancedBraces,
  paperEquationSchema, equationLatexLimit, assertEquationEvidence, assertPaperEquationBlock,
  type PaperEquation, type EquationEvidence} from '../../../shared/schemas/research-paper-equation';
import type {PaperBlock} from './paper-ir';

type Block = PaperBlock & {locations: EquationEvidence['locations']; imagePath?: string | null};
export function equationEvidence(block: Block, start = 0, end = block.text.length): EquationEvidence {
  return {blockId: block.id, locator: block.locator, text: block.text.slice(start, end), textSpan: {start, end}, locations: block.locations};
}
const numberPattern = /^(?:[A-Z][.-]?)?\d+(?:[.-]\d+)*$/u;
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const samePage = (a: Block, b: Block): boolean => a.locations.some(x => b.locations.some(y => x.page === y.page));
const body = (block: Block): boolean => block.kind === 'paragraph' && !isPageMargin(block.reading?.role) &&
  !['caption', 'equation_number'].includes(block.reading?.role ?? '') && Boolean(block.text.trim());

/** Derive only from original recognizer LaTeX and explicit located prose. Missing recognition stays null. */
export function attachPaperEquations<T extends Block>(blocks: readonly T[], pages: readonly {regions: unknown[]}[]): (T & {equation?: PaperEquation})[] {
  const regions = new Map<string, Record<string, unknown>>();
  for (const page of pages) for (const input of page.regions) {
    if (!input || typeof input !== 'object') continue;
    const region = input as Record<string, unknown>;
    if (typeof region.id !== 'string') continue;
    if (regions.has(region.id)) throw new Error('research_equation_binding_invalid');
    regions.set(region.id, region);
  }
  const equations = new Map<string, PaperEquation>();
  for (const [index, block] of blocks.entries()) {
    if (block.kind !== 'formula') continue;
    const location = block.locations[0];
    if (!location) throw new Error('research_equation_binding_invalid');
    const input = regions.get(block.id)?.formula;
    const rawLatex = typeof input === 'string' && input.trim() ? input : null;
    if (rawLatex && rawLatex.length > equationLatexLimit) throw new Error('research_equation_latex_too_large');
    const equation: PaperEquation = {version: paperEquationVersion, id: `equation:${block.id}`, blockId: block.id,
      status: rawLatex === null ? 'missing' : latexHasBalancedBraces(rawLatex) && !rawLatex.includes('\u0000') ? 'parsed' : 'invalid',
      rawLatex, normalizedLatex: rawLatex === null ? null : normalizePaperLatex(rawLatex), normalizationVersion: latexNormalizationVersion,
      equationNumber: null, numberEvidence: null, contexts: [], references: [], variables: [],
      source: {...location, locator: block.locator}, imagePath: block.imagePath ?? null, assetId: null, warnings: []};
    const tags = [...(rawLatex?.matchAll(/\\tag\*?\s*\{\s*((?:[A-Z][.-]?)?\d+(?:[.-]\d+)*)\s*\}/gu) ?? [])];
    const tag = tags.length === 1 ? tags[0] : null;
    if (tag) {
      equation.equationNumber = tag[1]!;
      equation.numberEvidence = {kind: 'latex', text: tag[0], start: tag.index!, end: tag.index! + tag[0].length};
    } else if (tags.length > 1) {
      equation.warnings.push('research_equation_number_ambiguous');
    } else {
      const numbers = [blocks[index - 1], blocks[index + 1]].filter((other): other is T => {
        if (!other || other.kind !== 'paragraph' || !samePage(block, other) || !/^\s*\((?:[A-Z][.-]?)?\d+(?:[.-]\d+)*\)\s*$/u.test(other.text)) return false;
        const box = other.locations.find(l => l.page === location.page && l.coordinateOrigin === location.coordinateOrigin)?.bbox;
        return Boolean(box && location.bbox && box[0] >= location.bbox[2] && box[1] < location.bbox[3] && box[3] > location.bbox[1]);
      });
      if (numbers.length === 1) {
        equation.equationNumber = numbers[0]!.text.trim().slice(1, -1);
        equation.numberEvidence = {kind: 'block', evidence: equationEvidence(numbers[0]!)};
      } else if (numbers.length > 1) equation.warnings.push('research_equation_number_ambiguous');
    }
    equation.contexts = blocks.slice(Math.max(0, index - 2), index + 3)
      .filter(other => body(other) && samePage(block, other) && !/^\s*\([\dA-Z.-]+\)\s*$/u.test(other.text))
      .map(other => equationEvidence(other));
    for (const context of equation.contexts) {
      // Definitions are quoted from nearby prose, never generated from the equation.
      const pattern = /(?:^|\bwhere\s+|\band\s+|其中\s*|[,，;；]\s*)(\$?(?:[A-Za-z](?:_\{?[A-Za-z0-9]+\}?)?|\\[A-Za-z]+)\$?)(?:\s+(?:denotes|represents|is defined as)\s+|\s*(?:表示|代表)\s*)([^.;。\n]{1,300})/giu;
      for (const match of context.text.matchAll(pattern)) {
        const symbol = match[1]!.replace(/^\$|\$$/gu, '');
        if (!rawLatex || !new RegExp(`(?<![A-Za-z])${escape(symbol)}(?![A-Za-z])`, 'u').test(rawLatex)) continue;
        const original = blocks.find(b => b.id === context.blockId)!;
        equation.variables.push({symbol, definition: match[2]!.trim(),
          evidence: equationEvidence(original, match.index!, match.index! + match[0].length)});
        if (equation.variables.length === 100) break;
      }
      if (equation.variables.length === 100) break;
    }
    if (rawLatex === null) equation.warnings.push('research_equation_recognition_missing');
    if (equation.status === 'invalid') equation.warnings.push('research_equation_latex_invalid');
    if (equation.equationNumber === null) equation.warnings.push('research_equation_number_missing');
    equations.set(block.id, equation);
  }
  const numberCounts = new Map<string, number>();
  for (const equation of equations.values()) if (equation.equationNumber) numberCounts.set(equation.equationNumber, (numberCounts.get(equation.equationNumber) ?? 0) + 1);
  for (const equation of equations.values()) {
    const number = equation.equationNumber;
    if (number && numberPattern.test(number)) {
      const ambiguous = numberCounts.get(number)! > 1;
      if (ambiguous) equation.warnings.push('research_equation_number_ambiguous');
      const pattern = new RegExp(`(?:\\bEq(?:uation)?s?\\.?|式)\\s*\\(?${escape(number)}\\)?(?![\\dA-Za-z]|[.-]\\d)`, 'giu');
      for (const block of blocks) if (body(block)) for (const match of block.text.matchAll(pattern)) {
        if (equation.references.length === 10_000) throw new Error('research_equation_reference_limit');
        equation.references.push({status: ambiguous ? 'candidate' : 'linked',
          evidence: equationEvidence(block, match.index!, match.index! + match[0].length)});
      }
    }
    const value = paperEquationSchema.parse(equation), block = blocks.find(b => b.id === equation.blockId)!;
    assertPaperEquationBlock({...block, equation: value});
    for (const evidence of [...value.contexts, ...value.references.map(r => r.evidence), ...value.variables.map(v => v.evidence),
      ...(value.numberEvidence?.kind === 'block' ? [value.numberEvidence.evidence] : [])]) assertEquationEvidence(evidence, blocks);
    equations.set(equation.blockId, value);
  }
  return blocks.map(block => equations.has(block.id) ? {...block, equation: equations.get(block.id)!} : {...block});
}
