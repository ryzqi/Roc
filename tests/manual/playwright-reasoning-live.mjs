import { _electron as electron } from '@playwright/test';
import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const packagedExe = resolve('release/win-unpacked/Roc.exe');
const dataRoot = join(homedir(), '.roc');
const agentDbPath = join(dataRoot, 'plugin-data', 'data', 'plugins', '@roc', 'plugin-agent.db');
const prompt = '每天晚上9点搜索今日金价，并记录到当前目录下的docx文件中。先思考，再执行。';

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function readLatestRuns(limit = 5) {
  const db = new Database(agentDbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT run_id, thread_id, type, created_at, payload_json
         FROM task_events
         ORDER BY created_at DESC, rowid DESC
         LIMIT 120`
      )
      .all();
    const runIds = [];
    const seen = new Set();
    for (const row of rows) {
      if (seen.has(row.run_id)) {
        continue;
      }
      seen.add(row.run_id);
      runIds.push(row.run_id);
      if (runIds.length >= limit) {
        break;
      }
    }
    return runIds.map((runId) => ({
      runId,
      events: db
        .prepare(
          `SELECT type, created_at, payload_json
           FROM task_events
           WHERE run_id = ?
           ORDER BY created_at ASC, rowid ASC`
        )
        .all(runId)
        .map((event) => ({
          type: event.type,
          createdAt: event.created_at,
          payload: safeParse(event.payload_json)
        }))
    }));
  } finally {
    db.close();
  }
}

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

const app = await electron.launch({
  executablePath: packagedExe,
  env: {
    ...process.env,
    ROC_DATA_ROOT: dataRoot
  }
});

try {
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="chat-view"]', { timeout: 30000 });
  await page.waitForSelector('[data-testid="chat-input"]', { timeout: 30000 });
  if ((await page.locator('[data-testid="chat-new-conversation"]').count()) > 0) {
    await page.click('[data-testid="chat-new-conversation"]');
    await page.waitForTimeout(500);
  }

  await page.fill('[data-testid="chat-input"]', prompt);
  await page.press('[data-testid="chat-input"]', 'Enter');

  const startedAt = Date.now();
  let uiReasoningText = null;
  let latestSnapshot = null;
  while (Date.now() - startedAt < 30000) {
    latestSnapshot = await page.evaluate(async () => {
      const snapshot = await window.roc.tasks.getSnapshot();
      return snapshot.ok
        ? {
            recentEvents: snapshot.data.recentEvents.slice(-15).map((event) => ({
              id: event.id,
              threadId: event.threadId,
              runId: event.runId,
              type: event.type,
              payload: event.payload
            }))
          }
        : { error: snapshot.error.message };
    });

    const reasoningLocator = page.locator('[data-testid="chat-activity-reasoning"]');
    if ((await reasoningLocator.count()) > 0) {
      uiReasoningText = await reasoningLocator.last().textContent();
      if (uiReasoningText && uiReasoningText.trim().length > 0) {
        break;
      }
    }
    await delay(1000);
  }

  const transcriptText = await page.locator('[data-testid="chat-transcript"]').textContent();
  const latestRuns = readLatestRuns();
  console.log(
    JSON.stringify(
      {
        packagedExe,
        dataRoot,
        prompt,
        uiReasoningText,
        transcriptText,
        latestSnapshot,
        latestRuns
      },
      null,
      2
    )
  );
} finally {
  await app.close();
}
