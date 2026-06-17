import { createHarnessProfile, registerHarnessProfile } from 'deepagents';

let registered = false;

/**
 * 关闭 deepagents 内置 SummarizationMiddleware。
 *
 * 原因：Roc 用自研 forge 分层压缩（createForgeTieredCompactionMiddleware）做上下文内
 * 压缩，内置摘要与之重叠；且内置默认把历史卸载到 /conversation_history，而 Roc 的
 * CompositeBackend 不路由该前缀，卸载会失败并每次触发告警、空耗一次摘要调用。
 *
 * harness profile 仅能表达 provider 级行为：Roc 的模型经 getModelProvider 解析后只会落到
 * 'anthropic'（ChatAnthropic）或 'openai'（全部 ChatOpenAI 系子类）两个 key，
 * 因此注册这两个 key 即覆盖全部 provider 类型。模块级守卫保证幂等，可安全重复调用。
 */
export function ensureRocHarnessProfilesRegistered(): void {
  if (registered) {
    return;
  }
  const profile = createHarnessProfile({
    excludedMiddleware: ['SummarizationMiddleware'],
    excludedTools: ['execute']
  });
  registerHarnessProfile('anthropic', profile);
  registerHarnessProfile('openai', profile);
  registered = true;
}
