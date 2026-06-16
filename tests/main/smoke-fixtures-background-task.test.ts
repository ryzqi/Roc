import { afterEach, describe, expect, it } from 'vitest';
import { startSmokeProvider } from '../smoke/lib/fixtures.mjs';

function nextDailyRunAtUtc(hour: number, minute: number, now = new Date()): string {
  const candidate = new Date(now.getTime());
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate.toISOString();
}

function readSseToolCallNameAndArgs(body: string): { name: string; args: unknown } {
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]');
  for (const line of lines) {
    const payload = JSON.parse(line.slice('data: '.length)) as {
      choices?: Array<{
        delta?: {
          tool_calls?: Array<{
            function?: {
              name?: string;
              arguments?: string;
            };
          }>;
        };
      }>;
    };
    const toolCall = payload.choices?.[0]?.delta?.tool_calls?.[0];
    const name = toolCall?.function?.name;
    const args = toolCall?.function?.arguments;
    if (typeof name === 'string' && typeof args === 'string') {
      return { name, args: JSON.parse(args) };
    }
  }
  throw new Error(`No tool call found in SSE body: ${body}`);
}

type SmokeRequestBody = {
  stream: true;
  tools: Array<{ type: 'function'; function: { name: string } }>;
  messages: Array<{ role: string; content: string }>;
};

describe('smoke provider background task proposal flow', () => {
  const providers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(providers.splice(0).map((provider) => provider.close()));
  });

  it('starts with propose_background_task and sends a cron trigger directly', async () => {
    const provider = await startSmokeProvider();
    providers.push(provider);
    const hour = 19;
    const minute = 40;
    const goal = `每天 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} 抓取 AI 新闻并写入 docx`;
    const response = await fetch(`${provider.endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream'
      },
      body: JSON.stringify({
        stream: true,
        tools: [
          { type: 'function', function: { name: 'propose_background_task' } },
          { type: 'function', function: { name: 'schedule_background_task' } },
          { type: 'function', function: { name: 'read_background_task' } }
        ],
        messages: [
          { role: 'system', content: '本轮工作流：创建后台任务。' },
          { role: 'system', content: 'Workspace: F:\\Code\\Roc' },
          { role: 'user', content: goal }
        ]
      } satisfies SmokeRequestBody)
    });
    const body = await response.text();
    const toolCall = readSseToolCallNameAndArgs(body);

    expect(response.status).toBe(200);
    expect(toolCall).toEqual({
      name: 'propose_background_task',
      args: {
        goal,
        trigger: {
          type: 'cron',
          description: `每天 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
          cronExpression: `${minute} ${hour} * * *`,
          nextRunAt: nextDailyRunAtUtc(hour, minute)
        },
        workspacePath: 'F:\\Code\\Roc'
      }
    });
  });
});
