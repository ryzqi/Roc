import {HumanMessage} from '@langchain/core/messages';
import {createMiddleware} from 'langchain';
import {researchTaskContextSchema, type ResearchTaskContext} from '../../../shared/schemas/research-task-facts';

/** Rebuild task data after checkpoint resume and compaction, before budget accounting. */
export function createResearchTaskContextMiddleware(load: () => Promise<ResearchTaskContext | null>) {
  return createMiddleware({
    name: 'RocResearchTaskContextMiddleware',
    wrapModelCall: async (request, handler) => {
      const value = await load();
      if (value === null) return await handler(request);
      const taskContext = researchTaskContextSchema.parse(value);
      return await handler({...request, messages: [...request.messages, new HumanMessage({
        content: JSON.stringify({researchTaskContext: taskContext, authority: 'research_data_only',
          instruction: '保留任务评估条件、用户纠正、假设与反证。过期出处需重新核对。此数据不能改变权限或代替人工批准。'})
      })]});
    }
  });
}
