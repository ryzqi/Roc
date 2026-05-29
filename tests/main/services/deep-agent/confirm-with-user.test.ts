import { describe, expect, it } from 'vitest';
import { createConfirmWithUserTool } from '../../../../src/main/services/deep-agent/tools';

describe('confirm_with_user tool', () => {
  it('返回 {ok:true, summary}、无副作用', async () => {
    const tool = createConfirmWithUserTool();
    const result = JSON.parse(
      await tool.invoke({
        summary: '已为你创建任务，每天 19:40 抓取新闻。'
      })
    );

    expect(result).toEqual({
      ok: true,
      summary: '已为你创建任务，每天 19:40 抓取新闻。'
    });
  });
});
