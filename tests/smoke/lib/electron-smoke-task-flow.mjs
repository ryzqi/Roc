import { waitForAppReady, waitForTextContent } from './assertions.mjs';
import { nextDailyRunAtUtc } from './electron-smoke-time.mjs';
import { seedSmokeRuntimeData } from './ipc.mjs';

export async function runSmokeTaskFlow(ctx) {
  const { page, artifactDir, skillSourceRoot, workspaceRoot, smokeProvider, backgroundTaskGoal, backgroundTaskCronExpression, backgroundTaskNextRunAt, naturalLanguageTaskGoal, naturalLanguageTaskCronExpression, naturalLanguageTaskClock } = ctx;
  const importedSkillId = await page.evaluate(async (sourcePath) => {
    const result = await window.roc.skills.importSkill({
      sourcePath
    });
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return result.data.id;
  }, skillSourceRoot);
  if (importedSkillId !== 'smoke-skill') {
    throw new Error(`Skill import mismatch: ${importedSkillId}`);
  }
  await page.reload();
  await waitForAppReady(page, 'after-skill-import', artifactDir);
  await page.waitForSelector('[data-testid="chat-input"]', { timeout: 5000 });
  const selectedWorkspace = await page.evaluate(async (workspacePath) => {
    const result = await window.roc.workspace.select({ path: workspacePath });
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return result.data.path;
  }, workspaceRoot);
  if (selectedWorkspace !== workspaceRoot) {
    throw new Error(`Workspace selection mismatch: ${selectedWorkspace}`);
  }
  await seedSmokeRuntimeData(page, {
    providerEndpoint: smokeProvider.endpoint,
    workspacePath: workspaceRoot,
    backgroundTaskGoal,
    backgroundTaskCronExpression,
    backgroundTaskNextRunAt
  });
  await page.reload();
  await waitForAppReady(page, 'after-runtime-seed', artifactDir);
  await page.waitForSelector('[data-testid="chat-input"]', { timeout: 5000 });
  await page.click('[data-testid="nav-tasks-board"]');
  await page.waitForSelector('[data-testid="tasks-board-view"]', { timeout: 5000 });
  await waitForTextContent(page, '[data-testid="tasks-board-view"]', backgroundTaskGoal, 15000);
  const manualRunNowEvidence = await page.evaluate(async (workspacePath) => {
    async function unwrap(result, label) {
      if (!result.ok) {
        throw new Error(`${label} failed: ${result.error.message}`);
      }
      return result.data;
    }

    const preview = await unwrap(
      await window.roc.tasks.createBackgroundTaskPreview({
        goal: 'Smoke manual run-now diagnostic task',
        trigger: {
          type: 'manual',
          description: 'manual smoke trigger'
        },
        workspacePath,
        allowedActions: ['dir'],
        forbiddenActions: [],
        failurePolicy: 'pause_and_report',
        notificationPolicy: 'failures_and_confirmations'
      }),
      'manual background task preview'
    );
    const task = await unwrap(await window.roc.tasks.createBackgroundTask(preview), 'manual background task create');
    const runNow = await unwrap(await window.roc.tasks.runBackgroundNow(task.id), 'manual background task run now');
    if (runNow.runId === task.id) {
      throw new Error('manual run-now returned task id instead of real run id');
    }
    await new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('manual run-now output timeout')), 10000);
      const poll = async () => {
        try {
          const detail = await unwrap(await window.roc.tasks.getTaskDetail({ taskId: task.id }), 'manual task detail');
          const hasOutput = detail.recentEvents.some((event) =>
            event.runId === runNow.runId &&
            (event.type === 'message' || event.type === 'assistant_block')
          );
          if (hasOutput) {
            window.clearTimeout(timeout);
            resolve(undefined);
            return;
          }
          window.setTimeout(poll, 250);
        } catch (error) {
          window.clearTimeout(timeout);
          reject(error);
        }
      };
      void poll();
    });
    const detail = await unwrap(await window.roc.tasks.getTaskDetail({ taskId: task.id }), 'manual task detail after run');
    return {
      taskId: task.id,
      runId: runNow.runId,
      returnedRealRunId: runNow.runId !== task.id,
      outputEventTypes: detail.recentEvents.filter((event) => event.runId === runNow.runId).map((event) => event.type)
    };
  }, workspaceRoot);
  await page.reload();
  await waitForAppReady(page, 'after-manual-run-now', artifactDir);
  await page.click('[data-testid="nav-tasks-board"]');
  await page.waitForSelector('[data-testid="tasks-board-view"]', { timeout: 5000 });
  await page.locator(`[data-testid="task-board-card-${manualRunNowEvidence.taskId}"]`).click();
  await page.waitForSelector('[data-testid="task-detail-view"]', { timeout: 10000 });
  await page.waitForSelector('[data-testid="chat-transcript"]', { timeout: 10000 });
  const manualRunDetailText = await page.textContent('[data-testid="task-detail-view"]');
  const manualRunTranscriptText = await page.textContent('[data-testid="chat-transcript"]');
  await page.getByRole('button', { name: '返回任务工作台' }).click();
  await page.waitForSelector('[data-testid="tasks-board-view"]', { timeout: 5000 });
  const backgroundTaskApiEvidence = await page.evaluate(async () => {
    const tray = await window.roc.lifecycle.getTraySummary();
    const snapshot = await window.roc.tasks.getSnapshot();
    const activeTasks = await window.roc.tasks.getActiveTasks();
    const schedulerStatus = await window.roc.tasks.getSchedulerStatus();
    if (!tray.ok) {
      throw new Error(tray.error.message);
    }
    if (!snapshot.ok) {
      throw new Error(snapshot.error.message);
    }
    if (!activeTasks.ok) {
      throw new Error(activeTasks.error.message);
    }
    if (!schedulerStatus.ok) {
      throw new Error(schedulerStatus.error.message);
    }
    return {
      activeTasks: activeTasks.data,
      schedulerStatus: schedulerStatus.data,
      tray: tray.data,
      hasCreatedEvent: snapshot.data.recentEvents.some((item) => item.type === 'background_task_created')
    };
  });
  await page.getByRole('button', { name: '新建任务' }).first().click();
  await page.waitForSelector('[data-testid="task-create-dialog-panel"]', { timeout: 5000 });
  await page.fill(
    '[data-testid="task-create-description"]',
    `${naturalLanguageTaskGoal}，使用当前工作区。`
  );
  await page.click('[data-testid="task-create-submit"]');
  const taskCreateOutcomeHandle = await page.waitForFunction(
    () => {
      if (document.querySelector('[data-testid="task-detail-view"]') !== null) {
        return { kind: 'detail' };
      }
      const error = document.querySelector('[data-testid="task-create-error"]')?.textContent;
      if (typeof error === 'string' && error.trim().length > 0) {
        return { kind: 'error', text: error.trim() };
      }
      return null;
    },
    null,
    { timeout: 30000 }
  );
  const taskCreateOutcome = await taskCreateOutcomeHandle.jsonValue();
  if (taskCreateOutcome.kind === 'error') {
    const taskCreateDebug = await page.evaluate(async () => {
      const activeTasks = await window.roc.tasks.getActiveTasks();
      const snapshot = await window.roc.tasks.getSnapshot();
      return {
        activeTasks: activeTasks.ok
          ? activeTasks.data.map((item) => ({
              taskId: item.taskId,
              threadId: item.threadId,
              goal: item.goal,
              status: item.status
            }))
          : activeTasks.error.message,
        recentEvents: snapshot.ok
          ? snapshot.data.recentEvents.slice(-12).map((item) => ({
              type: item.type,
              taskId: item.taskId,
              threadId: item.threadId,
              payload: item.payload
            }))
          : snapshot.error.message
      };
    });
    throw new Error(`Task create failed in smoke: ${taskCreateOutcome.text}\n${JSON.stringify(taskCreateDebug, null, 2)}`);
  }
  await page.waitForSelector('[data-testid="task-create-dialog-panel"]', { state: 'detached', timeout: 5000 });
  const createdTaskDetailText = await page.textContent('[data-testid="task-detail-view"]');
  await page.waitForFunction(
    async (expectedGoal) => {
      const activeTasks = await window.roc.tasks.getActiveTasks();
      return activeTasks.ok && activeTasks.data.some((item) => item.kind === 'background' && item.goal === expectedGoal);
    },
    naturalLanguageTaskGoal,
    { timeout: 15000 }
  );
  await page.getByRole('button', { name: '返回任务工作台' }).click();
  await page.waitForSelector('[data-testid="tasks-board-view"]', { timeout: 5000 });
  const taskText = await page.textContent('[data-testid="tasks-board-view"]');
  if (taskText === null) {
    throw new Error('Smoke could not read task board text.');
  }
  await page.waitForFunction(
    async () => {
      const snapshot = await window.roc.tasks.getSnapshot();
      if (!snapshot.ok) {
        return false;
      }
      const toolCalls = snapshot.data.recentEvents.filter((item) => {
        if (item.type !== 'tool_call' || typeof item.payload !== 'object' || item.payload === null) {
          return false;
        }
        return (
          Reflect.get(item.payload, 'name') === 'propose_background_task' ||
          Reflect.get(item.payload, 'name') === 'schedule_background_task'
        );
      });
      const hasToolCall = (name, status) =>
        toolCalls.some((item) => Reflect.get(item.payload, 'name') === name && Reflect.get(item.payload, 'status') === status);
      return (
        hasToolCall('propose_background_task', 'start') &&
        hasToolCall('propose_background_task', 'end') &&
        hasToolCall('schedule_background_task', 'start') &&
        hasToolCall('schedule_background_task', 'end')
      );
    },
    null,
    { timeout: 15000 }
  );
  const taskProposalEvidence = await page.evaluate(
    async ({ expectedGoal, expectedCronExpression, expectedNextRunAt }) => {
      const snapshot = await window.roc.tasks.getSnapshot();
      const activeTasks = await window.roc.tasks.getActiveTasks();
      if (!snapshot.ok) {
        throw new Error(snapshot.error.message);
      }
      if (!activeTasks.ok) {
        throw new Error(activeTasks.error.message);
      }
      const task = activeTasks.data.find((item) => item.kind === 'background' && item.goal === expectedGoal);
      const createdEvent = snapshot.data.recentEvents.find((item) => {
        if (item.type !== 'background_task_created' || typeof item.payload !== 'object' || item.payload === null) {
          return false;
        }
        return Reflect.get(item.payload, 'goal') === expectedGoal;
      });
      const schemaFailures = snapshot.data.recentEvents.filter((item) => {
        if (item.type !== 'error' || typeof item.payload !== 'object' || item.payload === null) {
          return false;
        }
        return Reflect.get(item.payload, 'code') === 'tool_input_schema_invalid';
      });
      const toolCalls = snapshot.data.recentEvents.filter((item) => {
        if (item.type !== 'tool_call' || typeof item.payload !== 'object' || item.payload === null) {
          return false;
        }
        return (
          Reflect.get(item.payload, 'name') === 'propose_background_task' ||
          Reflect.get(item.payload, 'name') === 'schedule_background_task'
        );
      });
      const toolCallErrors = toolCalls.flatMap((item) => {
        if (typeof item.payload !== 'object' || item.payload === null || Reflect.get(item.payload, 'status') !== 'error') {
          return [];
        }
        return [
          {
            name: Reflect.get(item.payload, 'name'),
            error: Reflect.get(item.payload, 'error')
          }
        ];
      });
      const hasToolCall = (name, status) =>
        toolCalls.some((item) => Reflect.get(item.payload, 'name') === name && Reflect.get(item.payload, 'status') === status);
      return {
        activeTaskGoal: task?.goal ?? null,
        createdEventPayload: createdEvent?.payload ?? null,
        cronExpression: task?.trigger.type === 'cron' ? task.trigger.cronExpression : null,
        hasCreatedEvent: createdEvent !== undefined,
        hasProposeToolCallStart: hasToolCall('propose_background_task', 'start'),
        hasProposeToolCallEnd: hasToolCall('propose_background_task', 'end'),
        hasScheduleToolCallStart: hasToolCall('schedule_background_task', 'start'),
        hasScheduleToolCallEnd: hasToolCall('schedule_background_task', 'end'),
        nextRunAt: task?.nextRunAt ?? null,
        schemaFailureCount: schemaFailures.length,
        toolCallErrors,
        triggerType: task?.trigger.type ?? null,
        expectedCronExpression,
        expectedNextRunAt
      };
    },
    {
      expectedGoal: naturalLanguageTaskGoal,
      expectedCronExpression: naturalLanguageTaskCronExpression,
      expectedNextRunAt: nextDailyRunAtUtc(naturalLanguageTaskClock.hour, naturalLanguageTaskClock.minute)
    }
  );

  Object.assign(ctx, {
    manualRunNowEvidence,
    manualRunDetailText,
    manualRunTranscriptText,
    backgroundTaskApiEvidence,
    createdTaskDetailText,
    taskText,
    taskProposalEvidence
  });
}
