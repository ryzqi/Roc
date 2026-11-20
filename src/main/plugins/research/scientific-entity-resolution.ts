import {scientificEntityProposalSchema, scientificEntitySchema, scientificEntityAliasSchema,
  type ScientificEntityProposal, type ScientificEntity, type ScientificEntityAlias} from '../../../shared/schemas/research-scientific-entities';
import {literatureIdentity, literatureIdentityAliases} from './literature-identity';
import {scientificKnowledgeId, scientificSourceMentions, createScientificSourceValidator,
  type ScientificValidationBasis} from './scientific-fact-validator';
import {researchContentHash} from './research-files';

/** Semantic/name similarity is retained as a candidate. It never supplies a cross-source identity. */
export function resolveScientificEntity(input: ScientificEntityProposal, basis: ScientificValidationBasis,
  aliases: readonly ScientificEntityAlias[] = [], targets: readonly ScientificEntity[] = []): ScientificEntity {
  const proposal = scientificEntityProposalSchema.parse(input), sources = createScientificSourceValidator(basis.ir), {ir} = sources;
  const evidence = proposal.evidence.map(sources.read);
  let identityBasis: ScientificEntity['identityBasis'], resolutionStatus: ScientificEntity['resolutionStatus'] = 'source_scoped';
  if (proposal.entityType === 'Paper') {
    if (proposal.attributes.title !== ir.metadata.title || proposal.attributes.doi !== ir.metadata.doi ||
      proposal.attributes.year !== ir.metadata.year || proposal.canonicalName !== (ir.metadata.title ?? ir.identity.paperId) ||
      !evidence.some(source => source.proposal.kind === 'metadata' &&
        source.proposal.field === (ir.metadata.title === null ? 'paperId' : 'title'))) {
      throw new Error('research_scientific_entity_metadata_invalid');
    }
    const identity = literatureIdentity({doi: ir.metadata.doi, source: 'roc', externalId: ir.identity.paperId});
    identityBasis = {kind: 'literature', identity, aliases: literatureIdentityAliases(identity)};
    resolutionStatus = 'exact';
  } else if ('objectId' in proposal.attributes) {
    const objectId = proposal.attributes.objectId;
    if (!evidence.some(e => e.proposal.kind === 'object' && e.proposal.objectId === objectId &&
      e.proposal.objectType === proposal.entityType)) throw new Error('research_scientific_entity_object_invalid');
    if (proposal.entityType === 'Equation') {
      const equation = ir.equations.find(e => e.id === objectId)!;
      if (proposal.attributes.latex !== equation.data.rawLatex || proposal.attributes.number !== equation.data.equationNumber ||
        proposal.canonicalName !== (equation.data.equationNumber === null ? equation.id : `Equation ${equation.data.equationNumber}`)) {
        throw new Error('research_scientific_entity_object_invalid');
      }
    }
    if (proposal.entityType === 'Figure' || proposal.entityType === 'Table') {
      const visual = proposal.entityType === 'Figure' ? ir.figures.find(e => e.id === objectId)!.data :
        ir.tables.find(e => e.id === objectId)!.visual;
      const number = visual?.objectNumber ?? (proposal.entityType === 'Table'
        ? ir.tables.find(table => table.id === objectId)!.data.tableNumber : null);
      if (proposal.attributes.number !== number ||
        proposal.canonicalName !== (number === null ? objectId : `${proposal.entityType} ${number}`) ||
        proposal.attributes.caption !== null && !visual?.captions.some(caption => caption.status === 'linked' &&
          caption.evidence.text === proposal.attributes.caption &&
          evidence.some(source => source.quote === caption.evidence.text))) {
        throw new Error('research_scientific_entity_object_invalid');
      }
    }
    if (proposal.entityType === 'Algorithm' && proposal.canonicalName !== objectId &&
      !evidence.some(source => scientificSourceMentions(source, proposal.canonicalName))) {
      throw new Error('research_scientific_entity_name_source_required');
    }
    identityBasis = {kind: 'object', documentId: ir.identity.documentId, objectId};
    resolutionStatus = 'exact';
  } else {
    if (!evidence.some(e => e.locator !== null && scientificSourceMentions(e, proposal.canonicalName))) {
      throw new Error('research_scientific_entity_name_source_required');
    }
    const provenanceHash = researchContentHash(JSON.stringify({canonicalName: proposal.canonicalName,
      attributes: proposal.attributes, sources: evidence.map(e => ({proposal: e.proposal, quote: e.quote}))}));
    identityBasis = {kind: 'source', documentId: ir.identity.documentId, provenanceHash};
  }
  let canonicalName = proposal.canonicalName;
  let id = scientificKnowledgeId('entity', [basis.projectId, proposal.entityType,
    identityBasis.kind === 'literature' ? [...identityBasis.aliases].sort()[0] : identityBasis]);
  const matching = aliases.map(a => scientificEntityAliasSchema.parse(a)).filter(a =>
    a.projectId === basis.projectId && a.entityType === proposal.entityType && a.alias === proposal.canonicalName);
  for (const alias of matching) {
    const target = targets.find(target => target.id === alias.targetEntityId);
    if (!target || target.projectId !== basis.projectId || target.entityType !== proposal.entityType ||
      target.status !== 'source_validated' || target.canonicalName !== alias.canonicalName) {
      throw new Error('research_scientific_entity_alias_target_invalid');
    }
    scientificEntitySchema.parse(target);
  }
  const targetIds = new Set(matching.map(a => a.targetEntityId));
  if (targetIds.size > 1) resolutionStatus = 'conflict';
  else if (matching.length && proposal.entityType !== 'Paper' && !('objectId' in proposal.attributes)) {
    const alias = matching.reduce((a, b) => a.revision > b.revision ? a : b);
    identityBasis = {kind: 'alias', aliasId: alias.id, revision: alias.revision, targetEntityId: alias.targetEntityId};
    id = alias.targetEntityId; canonicalName = alias.canonicalName; resolutionStatus = 'alias';
  }
  return scientificEntitySchema.parse({
    id, candidateId: proposal.id, projectId: basis.projectId, paperId: ir.identity.paperId,
    documentId: ir.identity.documentId, generationId: basis.generationId, entityType: proposal.entityType,
    canonicalName, aliases: proposal.aliases, proposal, evidence, scope: 'project', identityBasis,
    resolutionStatus, status: 'source_validated', scientificApproval: 'unreviewed'
  });
}
