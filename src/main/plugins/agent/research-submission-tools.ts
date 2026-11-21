import {tool} from 'langchain';
import {z} from 'zod';
import type {StructuredToolInterface} from '@langchain/core/tools';
import type {RocCapabilityRegistry} from '../../kernel/types';
import type {ResearchToolDescriptor} from './research-tools';
import {researchSubmissionProfileGetSchema,researchSubmissionProfileReceiptSchema,researchSubmissionProfileListSchema,
  researchSubmissionProfileListResultSchema,researchSubmissionProfileCompareSchema,researchSubmissionProfileDifferenceSchema} from '../../../shared/schemas/research-submission-profile';
import {researchSubmissionGetSchema,researchSubmissionListSchema,researchSubmissionReceiptSchema,
  researchSubmissionListResultSchema} from '../../../shared/schemas/research-submission';

export const RESEARCH_SUBMISSION_TOOL_DESCRIPTORS:readonly ResearchToolDescriptor[]=[
  {name:'research_submission_read',scope:'app',effectClass:'none',riskLevel:'low',executionScopes:['main','subagent']}
];
const requestSchema=z.discriminatedUnion('action',[
  researchSubmissionProfileListSchema.omit({projectId:true}).extend({action:z.literal('profiles')}),
  researchSubmissionProfileGetSchema.omit({projectId:true}).extend({action:z.literal('profile')}),
  researchSubmissionProfileCompareSchema.omit({projectId:true}).extend({action:z.literal('compare')}),
  researchSubmissionListSchema.omit({projectId:true}).extend({action:z.literal('submissions')}),
  researchSubmissionGetSchema.omit({projectId:true}).extend({action:z.literal('submission')})
]);
const schema=z.strictObject({action:z.enum(['profiles','profile','compare','submissions','submission']),
  offset:researchSubmissionListSchema.shape.offset.optional(),limit:researchSubmissionListSchema.shape.limit.optional(),
  versionId:researchSubmissionProfileGetSchema.shape.versionId.optional(),expectedHash:researchSubmissionProfileGetSchema.shape.expectedHash.optional(),
  left:researchSubmissionProfileCompareSchema.shape.left.optional(),right:researchSubmissionProfileCompareSchema.shape.right.optional(),
  submissionId:researchSubmissionGetSchema.shape.submissionId.optional()
}).pipe(requestSchema);
export function createResearchSubmissionTools(input:{projectId:string;signal:AbortSignal;capabilities:RocCapabilityRegistry}):StructuredToolInterface[]{
  const invoke=async<S extends z.ZodType>(name:string,request:object,output:S):Promise<z.output<S>>=>{
    input.signal.throwIfAborted();
    const value=await input.capabilities.invoke(name,{...request,projectId:input.projectId},input.signal);
    input.signal.throwIfAborted();return output.parse(value);
  };
  return [tool(async target=>{
    const {action,...request}=target;
    switch(action){
      case 'profiles':return invoke('research.submissionProfiles.list',request,researchSubmissionProfileListResultSchema);
      case 'profile':return invoke('research.submissionProfiles.get',request,researchSubmissionProfileReceiptSchema);
      case 'compare':return invoke('research.submissionProfiles.compare',request,researchSubmissionProfileDifferenceSchema);
      case 'submissions':return invoke('research.submissions.list',request,researchSubmissionListResultSchema);
      case 'submission':return invoke('research.submissions.get',request,researchSubmissionReceiptSchema);
    }
  },{name:'research_submission_read',schema,description:'读取当前项目保存的投稿配置、版本差异和真实投稿包预检。profiles/submissions 传 offset/limit；profile 用准确 versionId/expectedHash；compare 用准确 left/right；submission 用准确 submissionId。配置来自记录的期刊来源，实际交付需人工确认。manual 不等于通过，匿名检查只覆盖已知文本和所选文件。'})];
}
