import {researchReviewPilotRequestSchema, researchReviewPilotReportSchema,
  type ResearchReviewPilotRequest, type ResearchReviewPilotReport, type ResearchReviewPilotCell} from '../../../shared/schemas/research-review-pilot';
import type {ResearchRepository} from './repository';
import type {ResearchReviewFullTextFreeze} from './review-fulltext-freeze';
import type {ResearchReviewFullTextRepository} from './review-fulltext-repository';
import type {ResearchReviewExtractionRepository} from './review-extraction-repository';
import {researchContentHash} from './research-files';

type Material = ReturnType<ResearchReviewExtractionPilot['capture']>;
type Sample = ResearchReviewPilotReport['samples'][number];

/** A small source-checked field trial reuses ordinary extraction records without writing decisions. */
export class ResearchReviewExtractionPilot {
  constructor(private readonly research: ResearchRepository, private readonly freezing: ResearchReviewFullTextFreeze,
    private readonly bindings: ResearchReviewFullTextRepository, private readonly extractions: ResearchReviewExtractionRepository) {}

  async inspect(input: ResearchReviewPilotRequest): Promise<ResearchReviewPilotReport> {
    const request = researchReviewPilotRequestSchema.parse(input);
    const initial = this.capture(request), verified = new Map<string, Sample['sourceStatus']>();
    const failures = new Map<string, string>();
    for (const sample of initial.samples) {
      if (initial.archived) {verified.set(sample.hit.id, 'unavailable'); failures.set(sample.hit.id, 'project_archived'); continue;}
      if (!initial.phase.plan.currentProtocol || !initial.phase.sourcesCurrent || sample.binding === null ||
          sample.binding.referenceStatus !== 'current' || !sample.binding.isLatest) {
        verified.set(sample.hit.id, 'stale');
        continue;
      }
      try {
        if (sample.extraction !== null) {
          await this.extractions.verifyCurrent({projectId: request.projectId, corpusId: request.corpusId,
            extractionId: sample.extraction.snapshot.id, expectedExtractionHash: sample.extraction.snapshotHash});
        } else {
          await this.bindings.verifyCurrent({projectId: request.projectId, corpusId: request.corpusId,
            bindingId: sample.binding.snapshot.id, expectedBindingHash: sample.binding.snapshotHash});
        }
        verified.set(sample.hit.id, 'byte_checked');
      } catch (error) {
        if (!(error instanceof Error) || !/^research_[a-z0-9_]+(?:[:][a-z0-9_.-]+)*$/u.test(error.message) ||
            !/changed|conflict|not_found|superseded|unlocated/u.test(error.message)) throw error;
        verified.set(sample.hit.id, 'stale');
        failures.set(sample.hit.id, error.message.split(':')[0]);
      }
    }
    const current = this.capture(request);
    if (digest(initial) !== digest(current)) {
      for (const sample of current.samples) {verified.set(sample.hit.id, 'stale'); failures.set(sample.hit.id, 'material_changed_during_read');}
    }
    return this.report(request, current, verified, failures);
  }

  capture(request: ResearchReviewPilotRequest) {
    const phase = this.freezing.getPhase({projectId: request.projectId, corpusId: request.corpusId, phase: 'full_text'});
    if (phase.freeze === null || phase.freezeHash === null) throw new Error('research_review_screening_not_frozen');
    const protocol = this.research.systematicReviews.get({projectId: request.projectId, versionId: phase.plan.snapshot.protocolVersionId});
    const extractions = this.extractions.list({projectId: request.projectId, corpusId: request.corpusId});
    const samples = request.hitIds.map(hitId => {
      const frozen = phase.freeze!.authority.items.find(item => item.hit.id === hitId);
      if (frozen?.status !== 'included') throw new Error('research_review_pilot_hit_not_included');
      const current = phase.items.find(item => item.hit.id === hitId);
      const binding = current?.binding ?? null;
      if (frozen.binding === null || binding?.snapshot.id !== frozen.binding.id || binding.snapshotHash !== frozen.binding.expectedHash) {
        throw new Error('research_review_pilot_binding_changed');
      }
      return {hit: frozen.hit, binding, extraction: extractions.find(item => item.snapshot.request.hitId === hitId) ?? null};
    });
    return {phase, protocol, samples, archived: this.research.getProject(request.projectId).status === 'archived'};
  }

  private report(request: ResearchReviewPilotRequest, material: Material, verified: Map<string, Sample['sourceStatus']>, failures: Map<string, string>): ResearchReviewPilotReport {
    const {phase, protocol} = material;
    const issues: ResearchReviewPilotReport['issues'] = [], nextActions: ResearchReviewPilotReport['nextActions'] = [];
    const add = (code: string, action: ResearchReviewPilotReport['nextActions'][number]['action'], detail: string,
      hitId: string | null = null, fieldId: string | null = null): void => {
      if (issues.length < 300) issues.push({code, hitId, fieldId, detail});
      if (nextActions.length < 20) nextActions.push({actor: 'human', action, hitId, fieldId, detail});
    };
    if (!phase.plan.currentProtocol || protocol.versionHash !== request.expectedProtocolVersionHash) {
      add('protocol_changed', 'reread_protocol', '协议版本已变化；请先核对字段定义和本轮纳入范围。');
    }
    if (phase.freezeHash !== request.expectedFullFreezeHash) add('full_text_round_changed', 'reread_protocol', '所选全文轮次与当前冻结回执不一致。');
    const samples = material.samples.map(sample => {
      const hitId = sample.hit.id, extraction = sample.extraction, binding = sample.binding;
      const sourceStatus = verified.get(hitId) ?? 'unavailable';
      if (sourceStatus !== 'byte_checked') add(failures.get(hitId) ?? 'source_not_current', 'review_binding',
        '原始文件或提取来源尚未通过当前版本核对；先检查全文绑定和现有 Evidence。', hitId);
      if (extraction === null) add('sample_not_extracted', 'extract_sample', '此报告尚无人工提取；请使用下方原有表单试填。', hitId);
      const cell = (definition: {id: string; label: string; unit: string | null; required: boolean},
        stored: {value: ResearchReviewPilotCell['value']; evidence: {id: string}[]} | undefined): ResearchReviewPilotCell => {
        const status: ResearchReviewPilotCell['status'] = stored === undefined ? 'unextracted' :
          sourceStatus !== 'byte_checked' || extraction?.currentProtocol === false ? 'stale' :
          stored.value?.kind === 'missing' ? 'missing' : stored.value?.kind === 'unjudgeable' ? 'unjudgeable' : 'recorded';
        if (stored === undefined) add('field_unextracted', 'review_field', `字段「${definition.label}」尚未试填${definition.required ? '，此字段为必填' : ''}。`, hitId, definition.id);
        if (status === 'missing') add('field_missing', 'review_field', `字段「${definition.label}」已明确未找到；保留原因，判断定义是否需要调整。`, hitId, definition.id);
        if (status === 'unjudgeable') add('field_unjudgeable', 'review_field', `字段「${definition.label}」无法判断；核对判读规则和证据定位。`, hitId, definition.id);
        return {fieldId: definition.id, label: definition.label, unit: definition.unit, required: definition.required,
          status, value: stored?.value ?? null, evidenceIds: stored?.evidence.map(item => item.id) ?? [],
          reason: stored?.value?.kind === 'missing' || stored?.value?.kind === 'unjudgeable' ? stored.value.reason : null};
      };
      const fields = protocol.version.body.extractionFields.map(definition => cell(definition,
        extraction?.snapshot.request.fields.find(field => field.fieldId === definition.id)));
      const studyDesign = cell({id: 'study_design', label: '研究设计', required: true, unit: null}, extraction?.snapshot.request.studyDesign);
      return {hitId, title: binding?.snapshot.source?.filename ?? `原始命中 ${sample.hit.recordIndex + 1}`,
        binding: binding === null ? null : {id: binding.snapshot.id, hash: binding.snapshotHash},
        extraction: extraction === null ? null : {id: extraction.snapshot.id, hash: extraction.snapshotHash}, sourceStatus, studyDesign, fields};
    });
    const body = {projectId: request.projectId, corpusId: request.corpusId, protocolVersionId: protocol.version.id,
      protocolVersionHash: protocol.versionHash, fullFreezeHash: phase.freezeHash!, fieldDefinitions: protocol.version.body.extractionFields,
      attentionRequired: issues.length > 0, samples, issues, nextActions};
    const reportHash = digest(body);
    return researchReviewPilotReportSchema.parse({...body, reportHash,
      status: !phase.plan.currentProtocol || protocol.versionHash !== request.expectedProtocolVersionHash ||
        phase.freezeHash !== request.expectedFullFreezeHash || request.expectedReportHash !== null && request.expectedReportHash !== reportHash ? 'stale' : 'current'});
  }
}

function digest(value: unknown): string {return researchContentHash(JSON.stringify(value));}
