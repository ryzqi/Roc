import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { DatabasePool } from '../../../src/main/infrastructure/database-pool';
import { researchStageSchema } from '../../../src/shared/schemas/research';
import { defaultResearchIndexOptions } from '../../../src/shared/schemas/research-index';
import {
  applyAgentDatabaseSchema,
  applyCoreDatabaseSchema,
  applyDiagnosticsDatabaseSchema,
  applyMemoryDatabaseSchema,
  applyResearchDatabaseSchema,
  applyTaskDatabaseSchema,
  applyWorkspaceDatabaseSchema
} from '../../../src/main/infrastructure/database-schemas';

type PerformanceProfileRoots = {
  empty: string;
  profile1000: string;
  profile10000: string;
};

export function seedPerformanceProfiles(roots: PerformanceProfileRoots): void {
  seedProfile(roots.empty, 0, 'thread-profile-empty');
  seedProfile(roots.profile1000, 1_000, 'thread-profile-1000');
  seedProfile(roots.profile10000, 10_000, 'thread-profile-10000');
  if (countEvents(roots.profile1000) !== 1_000) {
    throw new Error('performance_profile_1000_seed_mismatch');
  }
  if (countEvents(roots.profile10000) !== 10_000) {
    throw new Error('performance_profile_10000_seed_mismatch');
  }
}

function readProfileRoots(): PerformanceProfileRoots {
  const raw = process.env.ROC_PERFORMANCE_PROFILE_ROOTS;
  if (raw === undefined || raw.trim().length === 0) {
    throw new Error('performance_profile_roots_missing');
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (
    typeof parsed.empty !== 'string' ||
    typeof parsed.profile1000 !== 'string' ||
    typeof parsed.profile10000 !== 'string'
  ) {
    throw new Error('performance_profile_roots_invalid');
  }
  return { empty: parsed.empty, profile1000: parsed.profile1000, profile10000: parsed.profile10000 };
}

function seedProfile(dataRoot: string, eventCount: number, threadId: string): void {
  const pool = new DatabasePool(join(dataRoot, 'plugin-data'));
  try {
    applyCoreDatabaseSchema(pool.getCoreConnection());
    const agentDb = pool.getConnection('@roc/plugin-agent');
    applyAgentDatabaseSchema(agentDb);
    applyMemoryDatabaseSchema(pool.getConnection('@roc/plugin-memory'));
    applyTaskDatabaseSchema(pool.getConnection('@roc/plugin-task'));
    applyWorkspaceDatabaseSchema(pool.getConnection('@roc/plugin-workspace'));
    applyDiagnosticsDatabaseSchema(pool.getConnection('@roc/plugin-diagnostics'));
    applyResearchDatabaseSchema(pool.getConnection('@roc/plugin-research'));
    // 默认入口是项目列表（ADR 0002：项目列表作为入口），不自动进入上次或第一个项目；
    // 没有项目就没有项目服务视图，对话输入也不会挂载。所以每个剖面都要带一个研究项目。
    seedResearchProject(pool, dataRoot, eventCount);
    if (eventCount === 0) {
      return;
    }
    agentDb
      .prepare(
        `INSERT INTO agent_threads (id, kind, title, goal, status, created_at, updated_at)
         VALUES (?, 'chat', ?, ?, 'completed', ?, ?)`
      )
      .run(threadId, `Profile ${eventCount}`, `Profile ${eventCount}`, '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z');
    // Each user turn belongs to a distinct run, as in a normal conversation.
    // A single run with 10k prompts reuses occurrence-based keys after paging.
    const insertRun = agentDb.prepare(
      `INSERT INTO agent_runs
       (id, thread_id, run_number, user_input, status, started_at, ended_at, provider_id, model_id,
        enabled_capabilities_json, workspace_path, task_source, workflow_hint)
       VALUES (?, ?, ?, 'profile', 'completed', ?, ?, NULL, NULL, ?, NULL, NULL, NULL)`
    );
    const insert = agentDb.prepare(
      `INSERT INTO agent_events (id, thread_id, run_id, sequence, type, payload_json, created_at)
       VALUES (?, ?, ?, ?, 'message', ?, ?)`
    );
    agentDb.transaction(() => {
      for (let sequence = 1; sequence <= eventCount; sequence += 1) {
        const runId = `run-${threadId}-${sequence}`;
        insertRun.run(runId, threadId, sequence, '2026-07-10T00:00:00.000Z', '2026-07-10T00:10:00.000Z', JSON.stringify({ mcpServers: [], skills: [] }));
        insert.run(
          `event-${threadId}-${sequence}`,
          threadId,
          runId,
          sequence,
          JSON.stringify({ role: 'user', content: `profile-marker-${eventCount}-${sequence}` }),
          new Date(Date.UTC(2026, 6, 10, 0, 0, 0, sequence)).toISOString()
        );
      }
    })();
  } finally {
    pool.closeAll();
  }
}

/**
 * 建一个性能剖面项目。
 *
 * 这里手写 SQL 而不是 `new ResearchRepository(db).createProject(...)`：后者会把整棵研究插件图
 * （含 `?raw` 资源与 `@napi-rs/canvas`）拉进夹具 bundle，esbuild 得为 `.md`/`.py`/`.node` 逐个配 loader。
 * 所以下面**逐条对齐** `ResearchRepository.createProject` + `ResearchRunRepository.initializeProject`
 * + `ResearchIndexRepository.initializeProject` 的写入。任何一处漏写都会让应用启动即失败
 * （漏 `research_index_projects` → `required_plugin_failed`；漏 stage states →
 * `research.workflow.get` 抛 `workflow_snapshot_stages_missing`，界面整屏空白）。
 */
function seedResearchProject(pool: DatabasePool, dataRoot: string, eventCount: number): void {
  const workspacePath = join(dataRoot, 'workspace');
  mkdirSync(workspacePath, { recursive: true });
  const projectId = `project-performance-${eventCount}`;
  const timestamp = '2026-07-10T00:00:00.000Z';
  const db = pool.getConnection('@roc/plugin-research');

  db.prepare(
    `INSERT INTO research_projects
     (id, title, description, workspace_path, status, current_stage, created_at, updated_at, language)
     VALUES (?, ?, ?, ?, 'active', 'discovery', ?, ?, 'zh')`
  ).run(projectId, `Performance Profile ${eventCount}`, 'performance profile project', workspacePath, timestamp, timestamp);

  // 与 `ResearchRepository.createProject` 的 stageGateRequired 一致（除 discovery 外全部需要人工闸门）。
  const gateRequired = new Set<string>([
    'retrieval',
    'reading',
    'ideation',
    'planning',
    'experiment',
    'figure',
    'writing',
    'review',
    'revision',
    'export'
  ]);
  const insertStage = db.prepare(
    `INSERT INTO research_stage_states
     (project_id, stage, status, active_run_id, artifact_ids_json, entered_at, completed_at, gate_required, gate_approved, last_error)
     VALUES (?, ?, ?, NULL, '[]', ?, NULL, ?, 0, NULL)`
  );
  researchStageSchema.options.forEach((stage, index) => {
    insertStage.run(projectId, stage, index === 0 ? 'ready' : 'locked', index === 0 ? timestamp : null, gateRequired.has(stage) ? 1 : 0);
  });

  // 与 `ResearchRunRepository.initializeProject` 一致。
  const insertPolicy = db.prepare('INSERT INTO research_stage_policies (project_id, stage, policy_json) VALUES (?, ?, ?)');
  for (const stage of researchStageSchema.options) {
    insertPolicy.run(
      projectId,
      stage,
      JSON.stringify({
        projectId,
        stage,
        tier: stage === 'retrieval' ? 'fast' : ['writing', 'review', 'revision'].includes(stage) ? 'deep' : 'balanced',
        model: { kind: 'app_default' },
        maxSteps: 30,
        timeoutMs: 180000
      })
    );
  }

  // 与 `ResearchIndexRepository.initializeProject` 一致。
  db.prepare(
    `INSERT INTO research_index_projects
     (project_id, options_json, revision, generation, workspace_path, root_path, archived, phase, error, scan_id,
      last_scan_at, embedding_key, scan_requested, scan_force, active_scan_force)
     VALUES (?, ?, 1, 1, ?, NULL, 0, 'idle', NULL, NULL, NULL, 'none', 0, 0, 0)`
  ).run(projectId, JSON.stringify(defaultResearchIndexOptions), workspacePath);
}

function countEvents(dataRoot: string): number {
  const pool = new DatabasePool(join(dataRoot, 'plugin-data'));
  try {
    return pool.getConnection('@roc/plugin-agent').prepare('SELECT COUNT(*) FROM agent_events').pluck().get() as number;
  } finally {
    pool.closeAll();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedPerformanceProfiles(readProfileRoots());
}
