import { describe, expect, it } from 'vitest';
import { RocDomainError } from '../../src/main/services/errors';
import { toRunFailure } from '../../src/main/services/deep-agent/error-mapping';
import { TOOL_ERROR_FIXTURES } from '../_fixtures/langchain-tool-errors';

describe('deep agent error mapping', () => {
  it('maps context budget contract failures to explicit non-retryable results', () => {
    expect(toRunFailure(new Error('context_budget_profile_invalid'))).toEqual({
      code: 'context_budget_profile_invalid',
      message: '模型上下文窗口无法容纳系统、工具、输出和安全预留，已停止本轮执行。',
      retryable: false
    });
    expect(toRunFailure(new Error('agent_context_budget_missing'))).toEqual({
      code: 'agent_context_budget_missing',
      message: '运行快照缺少模型上下文预算，已停止本轮执行。',
      retryable: false
    });
  });

  it('maps native model and tool call limit errors to a non-retryable budget failure', () => {
    expect(toRunFailure(new Error('Model call limits exceeded: run level call limit reached with 8 model calls'))).toEqual({
      code: 'run_budget_exhausted',
      message: '模型调用次数已达到本轮预算上限。',
      retryable: false
    });
    expect(toRunFailure(new Error("'run_shell_command' tool call limit reached: run limit exceeded (12/11 calls)."))).toEqual({
      code: 'run_budget_exhausted',
      message: '工具调用次数已达到本轮预算上限。',
      retryable: false
    });
  });

  it('maps LangChain tool schema failures before provider network classification', () => {
    const error = new Error(
      "Error invoking tool 'propose_background_task' with kwargs {'trigger': {'schedule': '50 21 * * *'}} with error:\n" +
        "Received tool input did not match expected schema: Invalid input: expected 'manual' | 'once' | 'cron' at trigger.type\n" +
        'Please fix your mistakes.'
    );

    expect(toRunFailure(error)).toEqual({
      code: 'tool_input_schema_invalid',
      diagnostic: {
        toolName: 'propose_background_task',
        schemaPath: 'trigger.type',
        badKeys: ['trigger.schedule']
      },
      message: '任务工具参数不符合 schema：propose_background_task 的输入不符合工具契约。',
      retryable: true,
      suggestion:
        'propose_background_task 模型只填写 goal 和 trigger；workspacePath、allowedActions、forbiddenActions、notificationPolicy、enabledCapabilities 由 runtime 设置。'
    });
  });

  it.each(TOOL_ERROR_FIXTURES)(
    'maps $name to tool_input_schema_invalid with structured diagnostic',
    ({ message, schemaPath, badKeys }) => {
      const failure = toRunFailure(new Error(message));
      expect(failure.code).toBe('tool_input_schema_invalid');
      expect(failure.diagnostic?.toolName).toBe('propose_background_task');
      expect(failure.diagnostic?.schemaPath).toBe(schemaPath);
      expect(failure.diagnostic?.badKeys ?? []).toEqual(badKeys);
      expect(failure.suggestion).toContain('模型只填写 goal 和 trigger');
      expect(failure.suggestion).toContain('workspacePath');
      expect(failure.suggestion).toContain('由 runtime 设置');
    }
  );

  it('points notificationPolicy default drift at the bad key with the minimal shape suggestion', () => {
    const fixture = TOOL_ERROR_FIXTURES.find((item) => item.name === 'notificationPolicy default');
    expect(fixture).not.toBeUndefined();
    const failure = toRunFailure(new Error(fixture?.message ?? ''));

    expect(failure.diagnostic).toEqual(
      expect.objectContaining({
        toolName: 'propose_background_task',
        schemaPath: 'notificationPolicy',
        badKeys: ['notificationPolicy']
      })
    );
    expect(failure.suggestion).toContain('模型只填写 goal 和 trigger');
    expect(failure.suggestion).toContain('workspacePath');
    expect(failure.suggestion).toContain('由 runtime 设置');
  });

  it('does not attach propose_background_task suggestions to other tool schema failures', () => {
    const failure = toRunFailure(
      new Error(
        "Error invoking tool 'web_read' with kwargs {'urlx': 'https://example.com'} with error:\n" +
          'Received tool input did not match expected schema: Unrecognized key: "urlx" at urlx\n' +
          'Please fix your mistakes.'
      )
    );

    expect(failure).toEqual({
      code: 'tool_input_schema_invalid',
      diagnostic: {
        toolName: 'web_read',
        schemaPath: 'urlx',
        badKeys: ['urlx']
      },
      message: '任务工具参数不符合 schema：web_read 的输入不符合工具契约。',
      retryable: true
    });
  });

  it('keeps user-visible message stable in Chinese', () => {
    const failure = toRunFailure(new Error(TOOL_ERROR_FIXTURES[0].message));
    expect(failure.message).toBe('任务工具参数不符合 schema：propose_background_task 的输入不符合工具契约。');
  });

  it('keeps web_read domain failures instead of re-labeling them as provider network errors', () => {
    const error = new RocDomainError({
      code: 'web_read_request_failed',
      message: 'web_read 请求失败：fetch failed',
      category: 'external',
      retryable: true,
      userAction: '请检查网络连接后重试。'
    });

    expect(toRunFailure(error)).toEqual({
      code: 'web_read_request_failed',
      message: 'web_read 请求失败：fetch failed',
      retryable: true
    });
  });

  it('keeps web_read tool failure text out of provider network error relabeling for plain errors', () => {
    expect(toRunFailure(new Error('web_read 请求失败：fetch failed'))).toEqual({
      code: 'web_read_request_failed',
      message: 'web_read 请求失败：fetch failed',
      retryable: true
    });
  });

  it('preserves non-retryable web_read http failures for plain errors', () => {
    expect(toRunFailure(new Error('web_read 请求失败：HTTP 404。'))).toEqual({
      code: 'web_read_http_error',
      message: 'web_read 请求失败：HTTP 404。',
      retryable: false
    });
  });

  it('preserves web_read empty-response failures for plain errors', () => {
    expect(toRunFailure(new Error('web_read 未返回可读正文。'))).toEqual({
      code: 'web_read_empty_response',
      message: 'web_read 未返回可读正文。',
      retryable: true
    });
  });

  it('preserves web_read validation failures for plain errors', () => {
    expect(toRunFailure(new Error('web_read 只支持合法的 HTTP/HTTPS URL。'))).toEqual({
      code: 'web_read_url_invalid',
      message: 'web_read 只支持合法的 HTTP/HTTPS URL。',
      retryable: false
    });
    expect(toRunFailure(new Error('web_read timeoutSeconds 必须是 1 到 180 之间的整数。'))).toEqual({
      code: 'web_read_timeout_invalid',
      message: 'web_read timeoutSeconds 必须是 1 到 180 之间的整数。',
      retryable: false
    });
    expect(toRunFailure(new Error('web_read 拒绝包含 credentials 的 URL。'))).toEqual({
      code: 'web_read_url_credentials',
      message: 'web_read 拒绝包含 credentials 的 URL。',
      retryable: false
    });
    expect(toRunFailure(new Error('web_read 只允许公开网络地址。'))).toEqual({
      code: 'web_read_private_url',
      message: 'web_read 只允许公开网络地址。',
      retryable: false
    });
    expect(toRunFailure(new Error('web_read 响应超过本地大小上限。'))).toEqual({
      code: 'web_read_response_too_large',
      message: 'web_read 响应超过本地大小上限。',
      retryable: false
    });
    expect(toRunFailure(new Error('web_read 已取消。'))).toEqual({
      code: 'web_read_aborted',
      message: 'web_read 已取消。',
      retryable: false
    });
  });

  it('preserves web_search unavailable fallback text for plain errors', () => {
    expect(toRunFailure(new Error('web_search 当前不可用。'))).toEqual({
      code: 'web_search_unavailable',
      message: 'web_search 当前不可用。',
      retryable: true
    });
  });

  it('keeps web_read http 408 and 425 non-retryable for plain errors to match WebReadService', () => {
    expect(toRunFailure(new Error('web_read 请求失败：HTTP 408。'))).toEqual({
      code: 'web_read_http_error',
      message: 'web_read 请求失败：HTTP 408。',
      retryable: false
    });
    expect(toRunFailure(new Error('web_read 请求失败：HTTP 425。'))).toEqual({
      code: 'web_read_http_error',
      message: 'web_read 请求失败：HTTP 425。',
      retryable: false
    });
  });
});
