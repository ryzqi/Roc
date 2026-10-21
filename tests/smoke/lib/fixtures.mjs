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

function buildSmokeContent(label, lines = 1) {
  return Array.from({ length: lines }, (_, index) => `${label} ${index + 1}`).join('\n') + '\n';
}

function runWorkspaceGit(workspaceRoot, args) {
  const result = spawnSync('git', args, {
    cwd: workspaceRoot,
    encoding: 'utf8',

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
  // Pin the initial branch to `master`.
  //
  // `git init` names the branch after `init.defaultBranch`, which is **ambient**: this machine's
  // CommandLineTools git sets it to `main` in its system config, while Homebrew's git defaults to
  // `master` — so the same suite passed or failed depending on which git the launching shell's
  // PATH resolved (P8 hit exactly that: three harnesses in a row failed on
  // `git push -u origin master` → `src refspec master does not match any`). Every assertion in
  // P3–P7 expects `master`, so the fixture renames it instead of inheriting the environment.
  runWorkspaceGit(workspaceRoot, ['branch', '-M', 'master']);
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

/**
 * P4 acceptance-gate modes (scripts/verify-p4-assistant.mjs).
 *
 * Same idea as the task-proposal flow above: the *prompt* selects the scripted turn, because
 * the fake provider is one HTTP endpoint with no per-test configuration. The marker is a plain
 * substring so it survives the composer's `/skill` parser (which only consumes `/`-prefixed
 * tokens) and stays readable in a failure report.
 */
const smokeP4ModePattern = /ROC-P4-MODE:([a-z]+)/u;
// Every scripted P4 prompt carries its own nonce. Thread history is *shared* between runs, so
// "find the newest marker in the transcript" would pick up the previous run's prompt and reuse
// its tool-call id — which then looks like an already-answered tool call and skips the script.
const smokeP4RunPattern = /ROC-P4-RUN:([A-Za-z0-9_-]+)/u;
const smokeP4DeletePattern = /ROC-P4-DELETE:(\S+)/u;
const smokeP4SlowPattern = /ROC-P4-SLOW:(\d+)x(\d+)/u;
// Per-gate tag so a transcript that already holds an earlier run's stream cannot satisfy a
// later gate's "did this come back" assertion.
const smokeP4SlowTagPattern = /ROC-P4-SLOW-TAG:([A-Za-z0-9_-]+)/u;
const smokeProviderText =
  'Smoke Provider 已生成首轮回复。\n\n短行一。\n短行二。\n短行三。\n短行四。\n短行五。\n短行六。\n短行七。\n短行八。';
const smokeTaskProposalClockPattern = /每天\s*(\d{1,2}):(\d{2})/;

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
    const systemPromptMatch = /^Workspace: (.+)$/mu.exec(text);
    if (systemPromptMatch !== null && systemPromptMatch[1].trim() !== 'not selected.') {
      return systemPromptMatch[1].trim();
    }
  }
  return null;
}

function readToolResultJson(messages, toolCallId) {
  const content = readToolResultText(messages, toolCallId);
  if (content === null) {
    return null;
  }
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Raw tool result for the P4 modes.
 *
 * Deliberately not JSON-parsed: `ls` returns a plain listing and `ask_user` returns the answer
 * string, so a JSON-only detector would report "no result yet" forever and the scripted model
 * would repeat the same tool call on every turn.
 */
function readToolResultText(messages, toolCallId) {
  if (!Array.isArray(messages)) {
    return null;
  }
  const message = [...messages].reverse().find((item) => item?.role === 'tool' && item?.tool_call_id === toolCallId);
  if (message === undefined) {
    return null;
  }
  return readTextContent(message.content);
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

function readFixtureNow(value) {
  if (value === undefined) {
    return new Date();
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error('Smoke provider now must be a valid Date.');
    }
    return new Date(value.getTime());
  }
  throw new Error('Smoke provider now must be a Date instance.');
}

function buildSmokeTaskProposalFinalText(taskProposalGoal) {
  return `Smoke Provider 已通过 propose / schedule 完成后台任务创建：${taskProposalGoal}。`;
}

function readLastUserText(messages, taskProposalGoal) {
  if (!Array.isArray(messages)) {
    return taskProposalGoal;
  }
  const message = [...messages].reverse().find((item) => item?.role === 'user');
  const text = readMessageText(message);
  return text.length === 0 ? taskProposalGoal : text;
}

function containsText(value, expectedText) {
  if (typeof value === 'string') {
    return value.includes(expectedText);
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsText(item, expectedText));
  }
  if (value === null || typeof value !== 'object') {
    return false;
  }
  return Object.values(value).some((item) => containsText(item, expectedText));
}

function readToolNames(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (item === null || typeof item !== 'object') {
      return [];
    }
    const directName = item.name;
    if (typeof directName === 'string') {
      return [directName];
    }
    const toolFunction = item.function;
    if (toolFunction !== null && typeof toolFunction === 'object' && typeof toolFunction.name === 'string') {
      return [toolFunction.name];
    }
    return [];
  });
}

function hasTaskProposalTools(parsedBody) {
  const toolNames = new Set(readToolNames(parsedBody?.tools));
  return toolNames.has('propose_background_task') && toolNames.has('schedule_background_task');
}

function isTaskProposalRequest(parsedBody, taskProposalGoal) {
  const messages = parsedBody?.messages;
  const hasTaskProposalPrompt = Array.isArray(messages)
    ? messages.some((message) => {
        const text = readMessageText(message);
        return text.includes('本轮工作流：创建后台任务。') || text.includes('必须调用 propose_background_task');
      })
    : false;
  if (hasTaskProposalPrompt || containsText(parsedBody, '本轮工作流：创建后台任务。')) {
    return true;
  }
  const lastUserText = readLastUserText(messages, '');
  return hasTaskProposalTools(parsedBody) && lastUserText.includes(taskProposalGoal);
}

function buildSmokeTaskProposal(trigger, taskProposalGoal) {
  // 不带 workspacePath：proposeToolInputSchema 是 strictObject，只接受 goal + trigger，
  // 工作区由 runtime 从会话注入。多传一个键会被判为 unrecognized_keys，整次工具调用失败。
  return {
    goal: taskProposalGoal,
    trigger
  };
}

function nextDailyRunAtUtc(hour, minute, now = new Date()) {
  const candidate = new Date(now.getTime());
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate.toISOString();
}

function buildSmokeCronTrigger(taskProposalGoal, now) {
  const match = smokeTaskProposalClockPattern.exec(taskProposalGoal);
  if (match === null) {
    throw new Error(`Smoke provider could not derive cron trigger from task proposal goal: ${taskProposalGoal}`);
  }
  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new Error(`Smoke provider parsed invalid cron trigger from task proposal goal: ${taskProposalGoal}`);
  }
  return {
    type: 'cron',
    description: `每天 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    cronExpression: `${minute} ${hour} * * *`,
    nextRunAt: nextDailyRunAtUtc(hour, minute, now)
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

function writeSseDelta(response, delta) {
  writeSseChunk(response, {
    choices: [
      {
        index: 0,
        delta,
        finish_reason: null
      }
    ]
  });
}

function writeSseFinish(response, finishReason, usage) {
  writeSseChunk(response, {
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: finishReason
      }
    ],
    usage
  });
  safeEndSse(response);
}

/**
 * Writes a chunk only while the client is still there.
 *
 * Gate 4 (cancel) and gate 5 (close the panel) both disconnect a streaming response mid-flight,
 * and a write to a destroyed socket throws `ERR_STREAM_WRITE_AFTER_END`. A test fixture that
 * crashes the smoke provider when the product cancels a run would report the cancellation as a
 * provider failure, which is the opposite of what it is.
 */
function safeWriteSseChunk(response, payload) {
  if (response.writableEnded || response.destroyed) {
    return false;
  }
  try {
    writeSseChunk(response, payload);
    return true;
  } catch {
    return false;
  }
}

function safeEndSse(response) {
  if (response.writableEnded || response.destroyed) {
    return;
  }
  try {
    response.end('data: [DONE]\n\n');
  } catch {
    // The client is gone; nothing to clean up beyond letting the socket close itself.
  }
}

function safeWriteSseFinish(response, finishReason, usage) {
  if (!safeWriteSseChunk(response, { choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage })) {
    return;
  }
  safeEndSse(response);
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

function writeTaskProposalToolCallResponse(response, parsedBody, taskProposalGoal, now) {
  // 仍然断言 prompt 里给过工作区：runtime 注入 workspacePath 时有值，否则 propose 会报 background_task_workspace_required。
  const workspacePath = readWorkspacePathFromMessages(parsedBody?.messages);
  if (workspacePath === null || workspacePath.length === 0) {
    throw new Error('Smoke provider could not resolve workspacePath from task proposal prompt.');
  }
  writeStreamingToolCallResponse(response, {
    id: 'call_smoke_propose_background_task',
    name: 'propose_background_task',
    args: buildSmokeTaskProposal(buildSmokeCronTrigger(taskProposalGoal, now), taskProposalGoal)
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

/**
 * Reads the newest scripted turn from the shared transcript.
 *
 * The prompt that carries a nonce decides the mode, the tool-call ids and every argument of that
 * turn, so a previous run's history can never be mistaken for this one's progress.
 */
function readSmokeP4Turn(messages) {
  if (!Array.isArray(messages)) {
    return null;
  }
  for (const message of [...messages].reverse()) {
    const text = readMessageText(message);
    const run = smokeP4RunPattern.exec(text);
    if (run === null) {
      continue;
    }
    const mode = smokeP4ModePattern.exec(text);
    if (mode === null) {
      continue;
    }
    return {
      nonce: run[1],
      mode: mode[1],
      deleteTarget: (smokeP4DeletePattern.exec(text) ?? [])[1] ?? null,
      slow: smokeP4SlowPattern.exec(text),
      tag: (smokeP4SlowTagPattern.exec(text) ?? [])[1] ?? 'P4SLOW'
    };
  }
  return null;
}

function smokeP4CallId(kind, nonce) {
  return `call_p4_${kind}_${nonce}`;
}
const smokeP4ReasoningText = 'P4 推理：先列出工作目录，再决定下一步。';
const smokeP4ToolDoneMarker = 'P4-TOOL-DONE';
const smokeP4ApprovalDoneMarker = 'P4-APPROVAL-DONE';
const smokeP4QuestionPrefix = 'P4-QUESTION-ANSWER:';

/**
 * A tool call must be the **first** delta of its response.
 *
 * Measured (2026-10-15, P4 gates): when a `content` delta precedes the `tool_calls` delta in the
 * same streamed response, the resulting `AIMessage.tool_calls` is **empty** — the raw call only
 * survives in `additional_kwargs`, and Roc's `ForgeRescueParsingMiddleware` then rebuilds it.
 * That rescue is invisible for a plain tool call, but it silently bypasses
 * `HumanInTheLoopMiddleware`: HITL only inspects `AIMessage.tool_calls`, so an approval-required
 * tool call that follows text in the same turn is executed **without an approval card**. The
 * fixture therefore scripts the tool call alone and writes the prose in the closing turn.
 */
function writeStreamingToolCallOnlyResponse(response, toolCall, usage) {
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
  writeSseFinish(response, 'tool_calls', usage);
}

/**
 * Gate 1: one **read-only** tool call, then a closing turn with reasoning + streaming text.
 *
 * `ls` is the deliberate choice: it is not in `interruptOn` under any permission mode, so the
 * run cannot be approved-or-rejected by accident, and its output is real filesystem data — the
 * assertion that a workspace filename shows up in the tool body is what proves the tool actually
 * executed rather than being echoed by the renderer.
 */
async function writeP4ToolModeResponse(response, parsedBody, turn) {
  // Keep the scripted running/streaming states observable on fast local providers.
  await new Promise(resolve => setTimeout(resolve, 250));
  const callId = smokeP4CallId('ls', turn.nonce);
  if (readToolResultText(parsedBody?.messages, callId) !== null) {
    // Reasoning and text in the *closing* turn keep this turn free of tool calls, so the
    // reasoning block and the streamed text are exercised without the shape issue documented
    // on `writeStreamingToolCallOnlyResponse`.
    writeSseDelta(response, { role: 'assistant', reasoning_content: smokeP4ReasoningText });
    await new Promise(resolve => setTimeout(resolve, 100));
    writeSseDelta(response, { content: '工具已返回，先记录看到的内容。' });
    writeSseDelta(response, { content: `\n\n结论完成。${smokeP4ToolDoneMarker}` });
    writeSseFinish(response, 'stop', { prompt_tokens: 42, completion_tokens: 24, total_tokens: 66 });
    return;
  }
  writeStreamingToolCallOnlyResponse(
    response,
    { id: callId, name: 'ls', args: { path: '/workspace' } },
    { prompt_tokens: 42, completion_tokens: 12, total_tokens: 54 }
  );
}

/**
 * P4 restart recovery: execute one read-only tool, then leave the model response streaming so the
 * acceptance harness can kill the Electron process after the tool checkpoint has been persisted.
 */
async function writeP4RestartModeResponse(response, parsedBody, turn) {
  const callId = smokeP4CallId('restart_ls', turn.nonce);
  if (readToolResultText(parsedBody?.messages, callId) === null) {
    writeStreamingToolCallOnlyResponse(
      response,
      { id: callId, name: 'ls', args: { path: '/workspace' } },
      { prompt_tokens: 42, completion_tokens: 12, total_tokens: 54 }
    );
    return;
  }
  await writeP4SlowModeResponse(response, {
    ...turn,
    slow: turn.slow ?? ['ROC-P4-SLOW:200x80', '200', '80'],
    tag: turn.tag === 'P4SLOW' ? 'P4CR' : turn.tag
  });
}

/**
 * Gate 2: one `delete_file` call, which only interrupts when `permissions.mode === 'default'`
 * (`run-capability-manifest.ts` → `createInterruptPolicy`). The harness sets that mode through
 * `settings.save` and asserts the card, then approves in one run and rejects in another.
 */
function writeP4ApprovalModeResponse(response, parsedBody, turn) {
  const callId = smokeP4CallId('delete', turn.nonce);
  if (readToolResultText(parsedBody?.messages, callId) !== null) {
    writeStreamingTextResponse(response, `审批流程已结束。${smokeP4ApprovalDoneMarker}`);
    return;
  }
  if (turn.deleteTarget === null) {
    throw new Error('Smoke provider approval mode needs a ROC-P4-DELETE:/workspace/... marker.');
  }
  writeStreamingToolCallOnlyResponse(
    response,
    { id: callId, name: 'delete_file', args: { file_path: turn.deleteTarget } },
    { prompt_tokens: 44, completion_tokens: 14, total_tokens: 58 }
  );
}

/**
 * Gate 3: one `ask_user` call, which interrupts with `kind: 'question'`.
 *
 * The closing turn echoes the **tool result**, which is the answer the user typed: that is what
 * proves the answer travelled through `chat.resumeRun({kind:'question'})` and back into the
 * model rather than only being rendered locally.
 */
function writeP4QuestionModeResponse(response, parsedBody, turn) {
  const callId = smokeP4CallId('ask', turn.nonce);
  const result = readToolResultText(parsedBody?.messages, callId);
  if (result !== null) {
    writeStreamingTextResponse(response, `收到回答：${result}\n\n${smokeP4QuestionPrefix}${result}`);
    return;
  }
  writeStreamingToolCallOnlyResponse(
    response,
    {
      id: callId,
      name: 'ask_user',
      args: {
        question: '这次运行要按哪个口径继续？',
        context: 'P4 提问中断的验收运行。',
        suggestedResponses: ['按最小范围继续', '先补数据再继续']
      }
    },
    { prompt_tokens: 48, completion_tokens: 18, total_tokens: 66 }
  );
}

/**
 * Gate 4/5: a long, slow text stream so the harness can cancel mid-run, close the panel and come
 * back while the run is still going. Each chunk is individually addressable (`P4SLOW-0007`) so a
 * later assertion can say which part of the stream it saw.
 */
async function writeP4SlowModeResponse(response, turn) {
  const parsedSlow = turn.slow;
  const totalChunks = parsedSlow === null ? 60 : Number.parseInt(parsedSlow[1], 10);
  const stepMs = parsedSlow === null ? 150 : Number.parseInt(parsedSlow[2], 10);
  const tag = turn.tag;
  for (let index = 1; index <= totalChunks; index += 1) {
    if (response.writableEnded || response.destroyed) {
      return;
    }
    const wrote = safeWriteSseChunk(response, {
      choices: [
        {
          index: 0,
          delta: { content: `${tag}-${String(index).padStart(4, '0')} ` },
          finish_reason: null
        }
      ]
    });
    if (!wrote) {
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, stepMs));
  }
  safeWriteSseFinish(response, 'stop', { prompt_tokens: 40, completion_tokens: totalChunks, total_tokens: 40 + totalChunks });
}

function writeP4ManyModeResponse(response) {
  writeStreamingTextResponse(response, 'P4MANY-ACK');
}

/* ------------------------------------------------------------------ */
/* P6 acceptance-gate modes (scripts/verify-p6-workflow.mjs)            */
/* ------------------------------------------------------------------ */

/**
 * Marker strings for the P6 gates.
 *
 * Same idea as the P4 modes: the fake provider is one endpoint with no per-test
 * configuration, so the *prompt* selects the scripted turn. A stage run's prompt is the role
 * system prompt (`你是 Roc 科研工作流的…`) plus a JSON user message containing the run's
 * `instruction`, which is where these markers travel.
 *
 *   ROC-P6-FAIL        → the provider fails the call, so the stage run really does fail
 *                        (`research_role_execution_failed`) — the plan's gate 2 needs a
 *                        genuine failure, not a mocked one.
 *   ROC-P6-TAG:<tag>   → stamped into the produced artifact's title/markdown so the harness
 *                        can prove *this* run's output reached the UI.
 */
const smokeP6FailPattern = /ROC-P6-FAIL/u;
const smokeP6TagPattern = /ROC-P6-TAG:([A-Za-z0-9_-]+)/u;
/** The role executor's system prompt is the only place this string appears. */
const smokeP6StagePromptMarker = '你是 Roc 科研工作流的';

function isResearchStageRequest(parsedBody) {
  return containsText(parsedBody, smokeP6StagePromptMarker);
}

function readP6Tag(parsedBody) {
  const match = containsText(parsedBody, 'ROC-P6-TAG:')
    ? smokeP6TagPattern.exec(JSON.stringify(parsedBody?.messages ?? []))
    : null;
  return match === null ? 'P6' : match[1];
}

function readP6FailureRequested(parsedBody) {
  return containsText(parsedBody, 'ROC-P6-FAIL') || smokeP6FailPattern.test(JSON.stringify(parsedBody ?? null));
}

/**
 * The structured-output tool's name, read from the request.
 *
 * `toolStrategy(researchStageOutputSchema)` derives the name from the schema's title and
 * falls back to a process-global counter (`extract-1`, `extract-2`, …), so the name is not a
 * constant: the fixture must read it from the request it is answering, exactly like a real
 * provider would. Name first, then a defensive check on the parameters.
 */
function readStructuredOutputToolName(parsedBody) {
  const tools = Array.isArray(parsedBody?.tools) ? parsedBody.tools : [];
  for (const tool of tools) {
    const fn = tool?.function ?? tool;
    if (typeof fn?.name === 'string' && /^extract-\d+$/u.test(fn.name)) {
      return fn.name;
    }
  }
  for (const tool of tools) {
    const fn = tool?.function ?? tool;
    const properties = fn?.parameters?.properties;
    if (typeof fn?.name === 'string' && properties !== null && typeof properties === 'object' && 'verdict' in properties && 'claims' in properties) {
      return fn.name;
    }
  }
  return null;
}

function writeP6StageOutput(response, parsedBody) {
  const toolName = readStructuredOutputToolName(parsedBody);
  if (toolName === null) {
    throw new Error('Smoke provider could not resolve the stage output tool name from the request.');
  }
  const tag = readP6Tag(parsedBody);
  const output = {
    title: `阶段产物 ${tag}`,
    // The raw marker is echoed into the Markdown on purpose: the harness then has one string that
    // can only come from *this* run's instruction, which is what proves the mounted artifact is
    // this run's output rather than a leftover.
    markdown: `## 阶段产物 ${tag}\n\nROC-P6-TAG:${tag}\n\n这是 P6 闸门夹具写出的真实结构化产物。`,
    // No `claims` with status 'supported': a supported claim would need real evidence ids,
    // and inventing them is the one thing the fixture must not do.
    claims: [
      {
        subjectType: 'paragraph',
        content: `夹具主张 ${tag}（待验证，不引用证据）`,
        status: 'pending',
        evidenceIds: []
      }
    ],
    sections: [],
    verdict: 'ready'
  };
  writeSseChunk(response, {
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `call_p6_output_${tag}`,
              type: 'function',
              function: { name: toolName, arguments: JSON.stringify(output) }
            }
          ]
        },
        finish_reason: null
      }
    ]
  });
  writeSseFinish(response, 'tool_calls', { prompt_tokens: 64, completion_tokens: 48, total_tokens: 112 });
}

/** A real provider failure, so the run fails with `research_role_execution_failed`. */
function writeP6FailureResponse(response) {
  response.statusCode = 500;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ error: { message: 'smoke provider forced failure (ROC-P6-FAIL)', type: 'server_error' } }));
}

export async function startSmokeProvider(input = {}) {
  const taskProposalGoal = readTaskProposalGoal(input.taskProposalGoal);
  const now = readFixtureNow(input.now);
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
        const p4Turn = readSmokeP4Turn(parsedBody?.messages);
        if (p4Turn !== null) {
          if (p4Turn.mode === 'tool') {
            await writeP4ToolModeResponse(response, parsedBody, p4Turn);
            return;
          }
          if (p4Turn.mode === 'restart') {
            await writeP4RestartModeResponse(response, parsedBody, p4Turn);
            return;
          }
          if (p4Turn.mode === 'approval') {
            writeP4ApprovalModeResponse(response, parsedBody, p4Turn);
            return;
          }
          if (p4Turn.mode === 'question') {
            writeP4QuestionModeResponse(response, parsedBody, p4Turn);
            return;
          }
          if (p4Turn.mode === 'slow') {
            await writeP4SlowModeResponse(response, p4Turn);
            return;
          }
          if (p4Turn.mode === 'many') {
            writeP4ManyModeResponse(response);
            return;
          }
          throw new Error(`Smoke provider does not know P4 mode: ${p4Turn.mode}`);
        }
        // P6: research stage runs speak the role executor's protocol, not the chat one.
        // Checked before the task-proposal fallback because a stage run's prompt is not a
        // chat prompt at all (it is the role system prompt + a JSON user message).
        if (isResearchStageRequest(parsedBody)) {
          if (readP6FailureRequested(parsedBody)) {
            writeP6FailureResponse(response);
            return;
          }
          writeP6StageOutput(response, parsedBody);
          return;
        }
        if (
          isTaskProposalRequest(parsedBody, taskProposalGoal) &&
          readToolResultJson(parsedBody?.messages, 'call_smoke_propose_background_task') === null
        ) {
          writeTaskProposalToolCallResponse(response, parsedBody, taskProposalGoal, now);
          return;
        }
        if (
          isTaskProposalRequest(parsedBody, taskProposalGoal) &&
          readToolResultJson(parsedBody?.messages, 'call_smoke_propose_background_task') !== null &&
          readToolResultJson(parsedBody?.messages, 'call_smoke_schedule_background_task') === null
        ) {
          writeTaskScheduleToolCallResponse(response, parsedBody);
          return;
        }
        writeStreamingTextResponse(
          response,
          isTaskProposalRequest(parsedBody, taskProposalGoal) ? smokeTaskProposalFinalText : smokeProviderText
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
      // A cancelled run destroys the response before its handler finishes; that is a successful
      // cancellation from the product's point of view, so do not try to answer on a dead socket.
      if (response.writableEnded || response.destroyed) {
        return;
      }
      try {
        response.statusCode = 500;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'provider failed' }));
      } catch {
        // Socket went away between the check and the write.
      }
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
