import {isDeepStrictEqual} from 'node:util';
import type {PaperIRV2} from '../../../shared/schemas/research-paper-ir-v2';
import type {ResearchSourceLocator} from '../../../shared/schemas/research-source-locator';
import {scientificGenerationReceiptSchema, type ScientificGenerationReceipt,
  type ScientificCandidate} from '../../../shared/schemas/research-scientific-search';
import {scientificSourceSchema, type ScientificSource} from '../../../shared/schemas/research-scientific-facts';
import {scientificSourceRefSchema, type ScientificSourceRef,
  type ScientificSourceObjectType} from '../../../shared/schemas/research-scientific-source-ref';
import {assertPaperIRArtifact} from './paper-ir-repository';
import {createScientificSourceValidator} from './scientific-fact-validator';

type SourceObject = {id: string; sourceLocator: ResearchSourceLocator};

/**
 * Bind refs to an owner-selected receipt and verified IR. The caller must still authorize the
 * project and check current source bytes/publication; a historical receipt is not authorization.
 * Index generationId never substitutes for an extraction job or a human review decision.
 */
export function createScientificSourceRefs(input: ScientificGenerationReceipt, ir: PaperIRV2): {
  fromCandidate: (candidate: ScientificCandidate) => ScientificSourceRef | null;
  fromSource: (source: ScientificSource) => ScientificSourceRef | null;
  assertBound: (ref: ScientificSourceRef) => void;
} {
  const receipt = scientificGenerationReceiptSchema.parse(input);
  assertPaperIRArtifact(receipt.paperIR, ir);
  const objects = new Map<string, {type: ScientificSourceObjectType; locator: ResearchSourceLocator}>();
  const add = (type: ScientificSourceObjectType, entries: readonly SourceObject[]) => {
    for (const object of entries) objects.set(object.id, {type, locator: structuredClone(object.sourceLocator)});
  };
  add('block', ir.blocks); add('section', ir.sections); add('table', ir.tables);
  add('table_cell', ir.tables.flatMap(table => table.cells));
  add('figure', ir.figures); add('equation', ir.equations); add('algorithm', ir.algorithms);
  add('algorithm_step', ir.algorithms.flatMap(algorithm => algorithm.steps));
  add('citation', ir.citations); add('reference', ir.references);
  const blockLengths = new Map(ir.blocks.map(block => [block.blockId, block.text.length]));
  const assertBound = (inputRef: ScientificSourceRef): void => {
    const ref = scientificSourceRefSchema.parse(inputRef);
    if (ref.generationId !== receipt.generationId || ref.paperIrHash !== receipt.paperIR.sha256 ||
        Object.entries(receipt.paperIR.identity).some(([key, value]) => ref[key as keyof ScientificSourceRef] !== value)) {
      throw new Error('research_scientific_source_ref_changed');
    }
    const entry = objects.get(ref.objectId), blockLength = blockLengths.get(ref.locator.blockId);
    if (!entry || entry.type !== ref.objectType || blockLength === undefined) throw new Error('research_scientific_source_ref_object_invalid');
    const expected = entry.locator;
    // Only a raw block can be narrowed to an exact UTF-16 text interval. Object geometry stays intact.
    const locator = ref.objectType === 'block' && ref.locator.textSpan
      ? {...expected, textSpan: ref.locator.textSpan} : expected;
    if (!isDeepStrictEqual(locator, ref.locator) || ref.locator.textSpan && ref.locator.textSpan.end > blockLength) {
      throw new Error('research_scientific_source_ref_locator_invalid');
    }
  };
  const project = (objectId: string, objectType: ScientificSourceObjectType,
    locator: ResearchSourceLocator): ScientificSourceRef => {
    const ref = scientificSourceRefSchema.parse({...receipt.paperIR.identity,
      paperIrHash: receipt.paperIR.sha256, generationId: receipt.generationId, objectId, objectType, locator});
    assertBound(ref);
    return ref;
  };
  let sourceValidator: ReturnType<typeof createScientificSourceValidator> | undefined;
  return {
    assertBound,
    fromCandidate: candidate => {
      if (candidate.generationId !== receipt.generationId || candidate.documentId !== receipt.paperIR.identity.documentId ||
          candidate.paperId !== receipt.paperIR.identity.paperId) throw new Error('research_scientific_source_ref_changed');
      if (candidate.objectType === 'metadata' || candidate.objectType === 'citation') {
        if (candidate.sourceLocator !== null) throw new Error('research_scientific_source_ref_object_invalid');
        return null;
      }
      if (candidate.sourceLocator === null) throw new Error('research_scientific_source_ref_locator_invalid');
      const type = candidate.objectType === 'paragraph' || candidate.objectType === 'caption' ? 'block' :
        candidate.objectType === 'table_row_group' ? 'table' : candidate.objectType;
      return project(candidate.objectId, type, candidate.sourceLocator);
    },
    fromSource: inputSource => {
      const source = scientificSourceSchema.parse(inputSource);
      if (!sourceValidator) {
        // The caller may have mutated its IR since construction. Validate it again before
        // the source validator captures its own detached, schema-parsed IR snapshot.
        assertPaperIRArtifact(receipt.paperIR, ir);
        sourceValidator = createScientificSourceValidator(ir);
      }
      sourceValidator.assertCurrent([source]);
      if (source.proposal.kind === 'metadata') return null;
      const locator = source.locator, entry = locator?.objectId ? objects.get(locator.objectId) : undefined;
      if (!locator || !entry) throw new Error('research_scientific_source_ref_object_invalid');
      return project(locator.objectId!, entry.type, locator);
    }
  };
}
