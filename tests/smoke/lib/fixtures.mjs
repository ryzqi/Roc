import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function createSmokePaths() {
  return {
    dataRoot: await mkdtemp(join(tmpdir(), 'roc-smoke-')),
    workspaceRoot: await mkdtemp(join(tmpdir(), 'roc-smoke-workspace-')),
    skillSourceRoot: await mkdtemp(join(tmpdir(), 'roc-smoke-skill-')),
    remoteRoot: await mkdtemp(join(tmpdir(), 'roc-smoke-remote-'))
  };
}

export function buildSmokeContent(label, lines = 1) {
  return Array.from({ length: lines }, (_, index) => `${label} ${index + 1}`).join('\n') + '\n';
}

export function runWorkspaceGit(workspaceRoot, args) {
  const result = spawnSync('git', args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

export function seedSmokeWorkspace(workspaceRoot, remoteRoot) {
  mkdirSync(join(workspaceRoot, 'assets'));
  mkdirSync(join(workspaceRoot, 'docs'));
  writeFileSync(join(workspaceRoot, '00-overview.txt'), 'workspace overview smoke file\n', 'utf8');
  writeFileSync(join(workspaceRoot, 'phase-three-notes.txt'), 'phase three smoke workspace\n', 'utf8');
  writeFileSync(join(workspaceRoot, 'batch-stage.txt'), 'batch stage smoke workspace\n', 'utf8');
  writeFileSync(
    join(workspaceRoot, 'docs', 'smoke-preview.pdf'),
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF', 'utf8')
  );
  writeFileSync(
    join(workspaceRoot, 'assets', 'smoke-image.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG3sAAAAASUVORK5CYII=',
      'base64'
    )
  );
  runWorkspaceGit(workspaceRoot, ['init']);
  runWorkspaceGit(workspaceRoot, ['config', 'user.email', 'roc-smoke@example.test']);
  runWorkspaceGit(workspaceRoot, ['config', 'user.name', 'Roc Smoke']);
  runWorkspaceGit(workspaceRoot, [
    'add',
    '00-overview.txt',
    'phase-three-notes.txt',
    'batch-stage.txt',
    'assets/smoke-image.png',
    'docs/smoke-preview.pdf'
  ]);
  runWorkspaceGit(workspaceRoot, ['commit', '-m', 'initial smoke workspace']);
  writeFileSync(
    join(workspaceRoot, 'phase-three-notes.txt'),
    `phase three smoke workspace\n${buildSmokeContent('changed in git line', 80)}`,
    'utf8'
  );
  writeFileSync(join(workspaceRoot, 'batch-stage.txt'), buildSmokeContent('changed in batch line', 32), 'utf8');
  runWorkspaceGit(workspaceRoot, ['init', '--bare', remoteRoot]);
  runWorkspaceGit(workspaceRoot, ['remote', 'add', 'origin', remoteRoot]);
  runWorkspaceGit(workspaceRoot, ['push', '-u', 'origin', 'master']);
}

export function seedSmokeSkillSource(skillSourceRoot) {
  writeFileSync(
    join(skillSourceRoot, 'SKILL.md'),
    '---\nname: smoke-skill\ndescription: Smoke skill validates Phase 5 import.\n---\n\n# Smoke Skill\n',
    'utf8'
  );
}

function readRequestBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    request.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on('error', rejectBody);
    request.on('end', () => {
      resolveBody(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

const defaultSmokeTaskProposalGoal = '每天 19:40 抓取 AI 新闻并写入 docx';
const smokeProviderText =
  'Smoke Provider 已生成首轮回复。\n\n短行一。\n短行二。\n短行三。\n短行四。\n短行五。\n短行六。\n短行七。\n短行八。';

function readTextContent(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (!Array.isArray(value)) {
    return '';
  }
  return value
    .map((item) => {
      if (typeof item === 'string') {
        return item;
      }
      if (item !== null && typeof item === 'object' && typeof item.text === 'string') {
        return item.text;
      }
      return '';
    })
    .join('\n');
}

function readMessageText(message) {
  if (message === null || typeof message !== 'object') {
    return '';
  }
  return readTextContent(message.content);
}

function readWorkspacePathFromMessages(messages) {
  if (!Array.isArray(messages)) {
    return null;
  }
  for (const message of [...messages].reverse()) {
    const text = readMessageText(message);
    const legacyMatch = /^当前工作区：(.+)$/mu.exec(text);
    if (legacyMatch !== null) {
      return legacyMatch[1].trim();
    }
    const systemPromptMatch = /^Workspace: (.+)$/mu.exec(text);
    if (systemPromptMatch !== null && systemPromptMatch[1].trim() !== 'not selected.') {
      return systemPromptMatch[1].trim();
    }
  }
  return null;
}

function readToolResultJson(messages, toolCallId) {
  if (!Array.isArray(messages)) {
    return null;
  }
  const message = [...messages].reverse().find((item) => item?.role === 'tool' && item?.tool_call_id === toolCallId);
  if (message === undefined) {
    return null;
  }
  const content = readTextContent(message.content);
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function readTaskProposalGoal(value) {
  if (value === undefined) {
    return defaultSmokeTaskProposalGoal;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Smoke provider taskProposalGoal must be a non-empty string.');
  }
  return value;
}

function buildSmokeTaskProposalFinalText(taskProposalGoal) {
  return `Smoke Provider 已通过 time / propose / schedule / confirm 完成后台任务创建：${taskProposalGoal}。`;
}

function readLastUserText(messages, taskProposalGoal) {
  if (!Array.isArray(messages)) {
    return taskProposalGoal;
  }
  const message = [...messages].reverse().find((item) => item?.role === 'user');
  const text = readMessageText(message);
  return text.length === 0 ? taskProposalGoal : text;
}

function isTaskProposalRequest(parsedBody) {
  const messages = parsedBody?.messages;
  const hasTaskProposalPrompt = Array.isArray(messages)
    ? messages.some((message) => {
        const text = readMessageText(message);
        return text.includes('本轮工作流：创建后台任务。') || text.includes('必须调用 propose_background_task');
      })
    : false;
  return hasTaskProposalPrompt;
}

function buildSmokeTaskProposal(workspacePath, trigger, taskProposalGoal) {
  return {
    goal: taskProposalGoal,
    trigger,
    workspacePath
  };
}

function writeSseChunk(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeStreamingTextResponse(response, content) {
  writeSseChunk(response, {
    choices: [
      {
        index: 0,
        delta: {
          content
        },
        finish_reason: null
      }
    ]
  });
  writeSseChunk(response, {
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: 'stop'
      }
    ],
    usage: {
      prompt_tokens: 16,
      completion_tokens: 9,
      total_tokens: 25
    }
  });
  response.end('data: [DONE]\n\n');
}

function writeStreamingToolCallResponse(response, toolCall) {
  writeSseChunk(response, {
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: toolCall.id,
              type: 'function',
              function: {
                name: toolCall.name,
                arguments: JSON.stringify(toolCall.args)
              }
            }
          ]
        },
        finish_reason: null
      }
    ]
  });
  writeSseChunk(response, {
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: 'tool_calls'
      }
    ],
    usage: {
      prompt_tokens: 42,
      completion_tokens: 12,
      total_tokens: 54
    }
  });
  response.end('data: [DONE]\n\n');
}

function writeTaskTimeResolutionToolCallResponse(response, parsedBody, taskProposalGoal) {
  writeStreamingToolCallResponse(response, {
    id: 'call_smoke_resolve_background_task_time',
    name: 'resolve_background_task_time',
    args: {
      text: readLastUserText(parsedBody?.messages, taskProposalGoal)
    }
  });
}

function writeTaskProposalToolCallResponse(response, parsedBody, taskProposalGoal) {
  const workspacePath = readWorkspacePathFromMessages(parsedBody?.messages);
  if (workspacePath === null || workspacePath.length === 0) {
    throw new Error('Smoke provider could not resolve workspacePath from task proposal prompt.');
  }
  const timeResult = readToolResultJson(parsedBody?.messages, 'call_smoke_resolve_background_task_time');
  if (timeResult?.status !== 'resolved' || timeResult.trigger === null || typeof timeResult.trigger !== 'object') {
    throw new Error('Smoke provider could not resolve trigger from resolve_background_task_time result.');
  }
  writeStreamingToolCallResponse(response, {
    id: 'call_smoke_propose_background_task',
    name: 'propose_background_task',
    args: buildSmokeTaskProposal(workspacePath, timeResult.trigger, taskProposalGoal)
  });
}

function writeTaskScheduleToolCallResponse(response, parsedBody) {
  const proposeResult = readToolResultJson(parsedBody?.messages, 'call_smoke_propose_background_task');
  if (typeof proposeResult?.previewId !== 'string') {
    throw new Error('Smoke provider could not resolve previewId from propose_background_task result.');
  }
  writeStreamingToolCallResponse(response, {
    id: 'call_smoke_schedule_background_task',
    name: 'schedule_background_task',
    args: {
      previewId: proposeResult.previewId
    }
  });
}

function writeTaskConfirmToolCallResponse(response, taskProposalGoal) {
  writeStreamingToolCallResponse(response, {
    id: 'call_smoke_confirm_with_user',
    name: 'confirm_with_user',
    args: {
      summary: `已创建后台任务：${taskProposalGoal}。`
    }
  });
}

export async function startSmokeProvider(input = {}) {
  const taskProposalGoal = readTaskProposalGoal(input.taskProposalGoal);
  const smokeTaskProposalFinalText = buildSmokeTaskProposalFinalText(taskProposalGoal);
  const requests = [];
  const server = createServer((request, response) => {
    void (async () => {
      const rawBody = await readRequestBody(request);
      const parsedBody = rawBody.length === 0 ? null : JSON.parse(rawBody);
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body: parsedBody
      });
      if (parsedBody?.stream === true || request.headers.accept === 'text/event-stream') {
        response.statusCode = 200;
        response.setHeader('content-type', 'text/event-stream');
        response.setHeader('cache-control', 'no-cache');
        response.setHeader('connection', 'keep-alive');
        if (
          isTaskProposalRequest(parsedBody) &&
          readToolResultJson(parsedBody?.messages, 'call_smoke_resolve_background_task_time') === null
        ) {
          writeTaskTimeResolutionToolCallResponse(response, parsedBody, taskProposalGoal);
          return;
        }
        if (
          isTaskProposalRequest(parsedBody) &&
          readToolResultJson(parsedBody?.messages, 'call_smoke_resolve_background_task_time') !== null &&
          readToolResultJson(parsedBody?.messages, 'call_smoke_propose_background_task') === null
        ) {
          writeTaskProposalToolCallResponse(response, parsedBody, taskProposalGoal);
          return;
        }
        if (
          isTaskProposalRequest(parsedBody) &&
          readToolResultJson(parsedBody?.messages, 'call_smoke_propose_background_task') !== null &&
          readToolResultJson(parsedBody?.messages, 'call_smoke_schedule_background_task') === null
        ) {
          writeTaskScheduleToolCallResponse(response, parsedBody);
          return;
        }
        if (
          isTaskProposalRequest(parsedBody) &&
          readToolResultJson(parsedBody?.messages, 'call_smoke_schedule_background_task') !== null &&
          readToolResultJson(parsedBody?.messages, 'call_smoke_confirm_with_user') === null
        ) {
          writeTaskConfirmToolCallResponse(response, taskProposalGoal);
          return;
        }
        writeStreamingTextResponse(
          response,
          isTaskProposalRequest(parsedBody) ? smokeTaskProposalFinalText : smokeProviderText
        );
        return;
      }
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: smokeProviderText
              },
              finish_reason: 'stop'
            }
          ],
          usage: {
            prompt_tokens: 16,
            completion_tokens: 9
          }
        })
      );
    })().catch((error) => {
      response.statusCode = 500;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'provider failed' }));
    });
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Smoke provider did not expose a TCP address.');
  }
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error !== undefined) {
            rejectClose(error);
            return;
          }
          resolveClose();
        });
      })
  };
}
