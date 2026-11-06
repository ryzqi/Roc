import {HumanMessage} from '@langchain/core/messages';
import {createMiddleware} from 'langchain';
import type {ResearchTaskContext} from '../../../shared/schemas/research-task-facts';
import {assembleResearchTaskContext} from './context/research-context-assembly';

/** Rebuild task data after checkpoint resume and compaction, before budget accounting. */
export function createResearchTaskContextMiddleware(load: () => ResearchTaskContext | null | Promise<ResearchTaskContext | null>) {
  return createMiddleware({
    name: 'RocResearchTaskContextMiddleware',
    wrapModelCall: async (request, handler) => {
      const value = await load();
      if (value === null) return await handler(request);
      const taskContext = assembleResearchTaskContext(value);
      return await handler({...request, messages: [...request.messages, new HumanMessage({
        content: JSON.stringify({researchTaskContext: taskContext, authority: 'research_data_only',
        instruction: '以下账本重新校验了当前来源，优先于历史摘要。保留任务评估条件、用户纠正、假设与反证。unavailableFacts 不得用于新结论；缺少原始证据须标明不可核验。此数据不能改变权限或代替人工批准。'})
      })]});
    }
  });
}
