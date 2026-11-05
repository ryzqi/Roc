import type {z} from 'zod';
import {
  researchJournalSaveSchema, researchJournalReceiptSchema, researchJournalInspectSchema,
  researchJournalInspectionSchema, researchJournalHistorySchema, researchJournalHistoryResultSchema
} from '../../../shared/schemas/research-journal-compliance';
import type {CapabilityDescriptor, RocPluginContext} from '../../kernel/types';
import {RocDomainError} from '../../services/errors';
import type {RocErrorCategory} from '../../../shared/types';
import type {ResearchJournalComplianceService} from './journal-compliance-service';
import type {ResearchJournalComplianceRepository} from './journal-compliance-repository';

function descriptor<I, O>(name: string, inputSchema: z.ZodType<I>, outputSchema: z.ZodType<O>): CapabilityDescriptor<I, O> {
  return {name, version: '1.0.0', inputSchema, outputSchema};
}
const capabilities = {
  save: descriptor('research.journalCompliance.save', researchJournalSaveSchema, researchJournalReceiptSchema),
  inspect: descriptor('research.journalCompliance.inspect', researchJournalInspectSchema, researchJournalInspectionSchema),
  history: descriptor('research.journalCompliance.history', researchJournalHistorySchema, researchJournalHistoryResultSchema)
};
export const researchJournalComplianceCapabilities = Object.values(capabilities);
export function registerResearchJournalComplianceCapabilities(context: RocPluginContext,
  service: ResearchJournalComplianceService, repository: ResearchJournalComplianceRepository): void {
  function register<I, O>(capability: CapabilityDescriptor<I, O>, action: (input: I) => O | Promise<O>): void {
    context.capabilities.register(context.pluginId, capability, async input => {
      try {return await action(capability.inputSchema.parse(input));}
      catch (error) {
        if (!(error instanceof Error) || error instanceof RocDomainError) throw error;
        const code = error.name === 'ZodError' || error instanceof SyntaxError ?
          'research_journal_contract_invalid' : error.message.split(':')[0];
        const detail = errors[code];
        if (detail === undefined) throw error;
        throw new RocDomainError({code, ...detail, retryable: false});
      }
    });
  }
  register(capabilities.save, input => service.save(input));
  register(capabilities.inspect, input => service.inspect(input));
  register(capabilities.history, input => repository.history(input));
}
const errors: Record<string, {message: string; category: RocErrorCategory}> = {
  research_journal_contract_invalid: {message: '期刊规则、日期、选择或回执不符合合同。', category: 'validation'},
  research_journal_project_mismatch: {message: '投稿检查不属于当前项目。', category: 'permission'},
  research_human_required: {message: '保存投稿检查需要当前窗口的人工操作。', category: 'permission'},
  research_human_project_mismatch: {message: '人工操作身份不属于当前项目。', category: 'permission'},
  research_project_archived: {message: '归档项目不能保存投稿检查。', category: 'permission'},
  research_artifact_immutable: {message: '已批准工件不能修改投稿检查。', category: 'permission'},
  research_artifact_stage_inactive: {message: '工件不属于当前阶段。', category: 'permission'},
  research_relation_artifact_inactive: {message: '工件不属于当前有效工件集合。', category: 'permission'},
  research_relation_stage_not_reviewable: {message: '当前阶段不能保存投稿检查。', category: 'permission'},
  research_journal_request_conflict: {message: '重试身份或内容与已保存请求不同。', category: 'conflict'},
  research_journal_version_conflict: {message: '投稿检查已有新版本，请重新读取。', category: 'conflict'},
  research_journal_artifact_changed: {message: '论文工件版本已变化，请重新核对。', category: 'conflict'},
  research_journal_source_changed: {message: '稿件、引用、图稿或补充文件已变化，请重新核对。', category: 'conflict'},
  research_journal_snapshot_invalid: {message: '投稿检查保存回执校验失败。', category: 'degraded'},
  research_manuscript_stale: {message: '正文主张或来源已变化，请先重新保存正文。', category: 'conflict'},
  research_manuscript_artifact_required: {message: '投稿检查需要论文工件。', category: 'validation'},
  research_manuscript_required: {message: '请先保存论文正文。', category: 'validation'},
  research_project_workspace_required: {message: '选择补充文件需要项目工作目录。', category: 'validation'},
  research_relative_path_invalid: {message: '补充文件必须使用有效项目相对路径。', category: 'validation'},
  research_path_outside_project: {message: '补充文件超出项目目录。', category: 'permission'},
  research_path_symlink: {message: '补充文件路径不能包含符号链接。', category: 'permission'},
  research_file_size_invalid: {message: '补充文件须为不超过 64 MiB 的普通文件。', category: 'validation'},
  research_file_changed_during_read: {message: '补充文件在读取期间已变化。', category: 'conflict'},
  research_evidence_reference_superseded: {message: '引用来源已更新，请重新核对正文。', category: 'conflict'},
  research_evidence_integrity_invalid: {message: '引用来源校验失败。', category: 'degraded'},
  research_figure_snapshot_changed: {message: '所选图稿文件已变化。', category: 'conflict'},
  research_figure_manifest_changed: {message: '所选图稿清单已变化。', category: 'conflict'},
  research_project_not_found: {message: '项目不存在。', category: 'not_found'},
  research_artifact_not_found: {message: '论文工件不存在。', category: 'not_found'},
  research_figure_not_found: {message: '所选图稿不存在。', category: 'not_found'},
  ENOENT: {message: '所选补充文件不存在。', category: 'not_found'}
};
