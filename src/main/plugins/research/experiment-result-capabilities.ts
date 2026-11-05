import type {z} from 'zod';
import {researchExperimentResultReviewSchema,researchExperimentResultGetSchema,researchExperimentResultListSchema,
  researchExperimentResultReceiptSchema,researchExperimentResultListResultSchema,
  researchExperimentCompareSchema,researchExperimentComparisonSchema} from '../../../shared/schemas/research-experiment-results';
import type {CapabilityDescriptor,RocPluginContext} from '../../kernel/types';
import type {ResearchExperimentResultService} from './experiment-result-service';
import type {ResearchExperimentResultRepository} from './experiment-result-repository';
import {RocDomainError} from '../../services/errors';
import type {RocErrorCategory} from '../../../shared/types';

const capabilities={
  review:descriptor('research.experimentResults.review',researchExperimentResultReviewSchema,researchExperimentResultReceiptSchema),
  get:descriptor('research.experimentResults.get',researchExperimentResultGetSchema,researchExperimentResultReceiptSchema),
  list:descriptor('research.experimentResults.list',researchExperimentResultListSchema,researchExperimentResultListResultSchema),
  compare:descriptor('research.experimentResults.compare',researchExperimentCompareSchema,researchExperimentComparisonSchema)
};
export const researchExperimentResultCapabilities=Object.values(capabilities);
export function registerResearchExperimentResultCapabilities(context:RocPluginContext,repository:ResearchExperimentResultRepository,
  service:ResearchExperimentResultService):void {
  function register<I,O>(capability:CapabilityDescriptor<I,O>,action:(input:I)=>O|Promise<O>):void {
    context.capabilities.register(context.pluginId,capability,async input=>
      resultBoundary(()=>action(capability.inputSchema.parse(input))));
  }
  register(capabilities.review,request=>service.review(request));
  register(capabilities.get,request=>service.get(request));
  register(capabilities.list,request=>repository.list(request));
  register(capabilities.compare,request=>service.compare(request));
}
const resultErrors:Record<string,{message:string;category:RocErrorCategory}>={
  research_result_request_conflict:{category:'conflict',message:'同一指标审核请求的内容或审核窗口已变化。'},
  research_result_input_changed:{category:'conflict',message:'实验输入或环境与选中的运行版本不一致。'},
  research_result_output_changed:{category:'conflict',message:'指标输出与选中的结果版本不一致。'},
  research_result_source_changed:{category:'conflict',message:'分析脚本与保存的结果版本不一致。'},
  research_result_execution_changed:{category:'conflict',message:'实验运行与保存的结果版本不一致。'},
  research_result_hash_mismatch:{category:'conflict',message:'指标审核回执与选中的校验值不一致。'},
  research_result_project_mismatch:{category:'permission',message:'指标审核回执不属于当前项目。'},
  research_result_not_found:{category:'not_found',message:'指标审核回执不存在。'},
  research_result_snapshot_invalid:{category:'degraded',message:'保存的指标审核回执校验失败。'},
  research_result_completed_required:{category:'validation',message:'指标审核需要已完成且保存环境与输入的实验运行。'},
  research_result_file_missing:{category:'not_found',message:'指标审核引用的实验文件不存在。'},
  research_result_file_limit:{category:'validation',message:'指标输出超过 1 MiB 上限。'},
  research_result_definitions_incomplete:{category:'validation',message:'请确认实际输出中的全部指标定义。'},
  research_result_definition_mismatch:{category:'validation',message:'指标定义的 ID 或单位与实际输出不一致。'},
  research_project_archived:{category:'permission',message:'项目已归档，无法保存指标审核。'},
  research_project_not_found:{category:'not_found',message:'科研项目不存在。'},
  research_human_required:{category:'permission',message:'指标审核需要有效的人工审核窗口身份。'},
  research_human_project_mismatch:{category:'permission',message:'指标审核窗口与当前项目不一致。'},
  research_experiment_not_found:{category:'not_found',message:'实验运行不存在。'},
  research_experiment_project_mismatch:{category:'permission',message:'实验运行不属于当前项目。'},
  research_experiment_completed_required:{category:'validation',message:'指标核对需要已完成的实验运行。'},
  research_experiment_file_not_found:{category:'not_found',message:'保存的实验文件不存在。'},
  research_experiment_snapshot_invalid:{category:'degraded',message:'保存的实验运行校验失败。'},
  research_experiment_manifest_changed:{category:'degraded',message:'实验文件与保存的发布版本不一致。'},
  research_experiment_snapshot_changed:{category:'degraded',message:'实验文件与保存的内容校验值不一致。'},
  research_experiment_resource_report_changed:{category:'degraded',message:'实验资源回执与保存的运行版本不一致。'},
  research_experiment_native_code_report_changed:{category:'degraded',message:'实验原生代码回执与保存的运行版本不一致。'},
  research_experiment_python_code_report_changed:{category:'degraded',message:'Python 代码回执与保存的运行版本不一致。'},
  research_experiment_python_startup_report_changed:{category:'degraded',message:'Python 启动回执与保存的运行版本不一致。'},
  research_experiment_notebook_source_changed:{category:'degraded',message:'Notebook 来源与保存的运行版本不一致。'},
  research_path_symlink:{category:'permission',message:'实验文件路径包含符号链接，无法核对来源。'},
  research_path_outside_project:{category:'permission',message:'实验文件路径超出项目范围。'},
  research_file_size_invalid:{category:'validation',message:'保存的实验文件类型或大小不符合读取合同。'},
  research_file_changed_during_read:{category:'conflict',message:'实验文件在读取过程中发生变化。'}
};
async function resultBoundary<T>(action:()=>T|Promise<T>):Promise<T> {
  try {return await action();}
  catch(error) {
    if(!(error instanceof Error)||error instanceof RocDomainError)throw error;
    if(error.name==='ZodError'||error instanceof SyntaxError)throw new RocDomainError({
      code:'research_result_contract_invalid',category:'validation',
      message:'指标审核请求、保存回执或实际输出不符合指标合同。',retryable:false});
    const nativeCode=(error as NodeJS.ErrnoException).code;
    if(nativeCode==='ENOENT')throw new RocDomainError({code:'research_result_file_missing',category:'not_found',
      message:'指标审核引用的实验文件或清单缺失。',retryable:false});
    if(nativeCode==='EACCES'||nativeCode==='EPERM')throw new RocDomainError({code:'research_result_file_denied',category:'permission',
      message:'当前无法访问指标审核引用的实验文件。',retryable:false});
    if(nativeCode==='ERR_ENCODING_INVALID_ENCODED_DATA')throw new RocDomainError({code:'research_result_encoding_invalid',
      category:'validation',message:'实际指标输出不是有效的 UTF-8 文本。',retryable:false});
    const code=error.message.split(':')[0],detail=resultErrors[code];
    if(detail===undefined)throw error;
    throw new RocDomainError({code,...detail,retryable:false});
  }
}
function descriptor<I,O>(name:string,inputSchema:z.ZodType<I>,outputSchema:z.ZodType<O>):CapabilityDescriptor<I,O> {
  return {name,version:'1.0.0',inputSchema,outputSchema};
}
