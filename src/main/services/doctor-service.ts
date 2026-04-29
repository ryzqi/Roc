import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DoctorFinding, DoctorSnapshot } from '../../shared/types';
import type { ConfigService } from './config-service';
import type { DatabaseService } from './database-service';
import type { DiagnosticsService } from './diagnostics-service';
import type { LifecycleService } from './lifecycle-service';
import type { McpService } from './mcp-service';
import type { MemoryService } from './memory-service';
import type { RocPaths } from './paths';
import type { RtkService } from './rtk-service';
import type { SkillService } from './skill-service';
import type { TaskService } from './task-service';
import type { WorkspaceService } from './workspace-service';

export class DoctorService {
  constructor(
    private readonly paths: RocPaths,
    private readonly config: ConfigService,
    private readonly database: DatabaseService,
    private readonly memory: MemoryService,
    private readonly workspace: WorkspaceService,
    private readonly taskService: TaskService,
    private readonly lifecycleService: LifecycleService,
    private readonly diagnosticsService: DiagnosticsService,
    private readonly mcpService: McpService,
    private readonly skillService: SkillService,
    private readonly rtkService: RtkService
  ) {}

  getLatest(): DoctorSnapshot {
    const latestRun = this.database.db
      .prepare('SELECT id, generated_at FROM doctor_runs ORDER BY generated_at DESC LIMIT 1')
      .get() as { id: string; generated_at: string } | undefined;
    if (latestRun === undefined) {
      return this.run();
    }

    const findings = this.database.db
      .prepare(
        `SELECT id, check_id, severity, status, title, detail, repair_action_json, created_at
         FROM doctor_findings
         WHERE run_id = ?
         ORDER BY created_at ASC`
      )
      .all(latestRun.id) as Array<{
      id: string;
      check_id: string;
      severity: DoctorFinding['severity'];
      status: DoctorFinding['status'];
      title: string;
      detail: string;
      repair_action_json: string | null;
      created_at: string;
    }>;

    const normalizedFindings = findings.map((finding) => ({
      id: finding.id,
      checkId: finding.check_id,
      severity: finding.severity,
      status: finding.status,
      title: finding.title,
      detail: finding.detail,
      repairAction:
        finding.repair_action_json === null
          ? undefined
          : (JSON.parse(finding.repair_action_json) as DoctorFinding['repairAction']),
      createdAt: finding.created_at
    }));

    return {
      generatedAt: latestRun.generated_at,
      summary: this.summarize(normalizedFindings),
      findings: normalizedFindings
    };
  }

  run(): DoctorSnapshot {
    const createdAt = new Date().toISOString();
    const memoryStatus = this.memory.status();
    const defaultModelConfigured = this.config.hasDefaultModel();
    const currentWorkspace = this.workspace.getCurrentWorkspace();
    const rtkStatus = this.rtkService.getStatus();
    const backgroundTasks = this.taskService.getBackgroundTaskSummary();
    const traySummary = this.lifecycleService.getTraySummary();
    const latestPerformance = this.diagnosticsService.getLatestPerformanceSample();
    const mcpServers = this.mcpService.listServers();
    const skills = this.skillService.list();
    const findings: DoctorFinding[] = [
      this.finding('paths.root', existsSync(this.paths.root), 'Roc 数据根目录', this.paths.root, createdAt, 'error', {
        label: '打开数据根目录',
        action: this.paths.root
      }),
      this.finding('database.sqlite', existsSync(this.paths.databasePath), 'SQLite 数据库', this.paths.databasePath, createdAt, 'error', {
        label: '重新初始化数据库',
        action: 'run_doctor_after_restart'
      }),
      this.finding('logs.directory', existsSync(this.paths.logsDir), '日志目录', this.paths.logsDir, createdAt, 'warning', {
        label: '打开日志目录',
        action: this.paths.logsDir
      }),
      this.finding(
        'diagnostics.directory',
        existsSync(this.paths.diagnosticsDir),
        '诊断目录',
        this.paths.diagnosticsDir,
        createdAt,
        'warning',
        {
          label: '打开诊断目录',
          action: this.paths.diagnosticsDir
        }
      ),
      this.finding(
        'recovery.directory',
        existsSync(join(this.paths.tasksDir, 'recovery')),
        '恢复点目录',
        join(this.paths.tasksDir, 'recovery'),
        createdAt,
        'warning',
        {
          label: '打开恢复点目录',
          action: join(this.paths.tasksDir, 'recovery')
        }
      ),
      this.finding('memory.hot', existsSync(memoryStatus.layers.hot.path), '热记忆目录', memoryStatus.layers.hot.path, createdAt, 'warning', {
        label: '打开记忆目录',
        action: memoryStatus.layers.hot.path
      }),
      this.finding(
        'memory.index',
        memoryStatus.fullTextIndex.healthy,
        '记忆索引',
        `FTS: ${memoryStatus.fullTextIndex.status}; Vector: ${memoryStatus.vectorIndex.status}`,
        createdAt,
        'warning',
        {
          label: '重建记忆索引',
          action: 'memory_rebuild_index'
        }
      ),
      this.finding(
        'workspace.default',
        currentWorkspace !== null && existsSync(currentWorkspace.path),
        '默认工作区',
        currentWorkspace === null ? '尚未选择默认工作区。' : currentWorkspace.path,
        createdAt,
        'warning',
        {
          label: '选择工作区',
          action: 'open_workspace_picker'
        }
      ),
      this.finding(
        'provider.default_model',
        defaultModelConfigured,
        '默认模型配置',
        defaultModelConfigured ? '默认模型已配置。' : '尚未配置默认模型，聊天和任务执行会被阻断。',
        createdAt,
        'warning',
        {
          label: '打开模型设置',
          action: 'open_provider_settings'
        }
      ),
      this.finding(
        'mcp.servers',
        mcpServers.length > 0,
        'MCP 配置',
        mcpServers.length === 0 ? '尚未配置 MCP server。' : `已配置 ${mcpServers.length} 个 MCP server。`,
        createdAt,
        'warning',
        {
          label: '打开 MCP 管理',
          action: 'open_mcp_settings'
        }
      ),
      this.finding(
        'skills.scan',
        skills.every((skill) => skill.status === 'ready'),
        'Skill 扫描',
        `已扫描 ${skills.length} 个 Skill。`,
        createdAt,
        'warning',
        {
          label: '打开 Skill 管理',
          action: 'open_skill_settings'
        }
      ),
      this.finding(
        'background.tasks',
        backgroundTasks.failed === 0,
        '后台任务',
        `后台任务 ${backgroundTasks.total} 个，运行中 ${backgroundTasks.running} 个，失败 ${backgroundTasks.failed} 个，待确认 ${backgroundTasks.pendingConfirmation} 个。`,
        createdAt,
        'warning',
        {
          label: '打开任务工作台',
          action: 'open_task_command_center'
        }
      ),
      this.finding(
        'tray.lifecycle',
        traySummary.residentEnabled,
        '托盘与后台执行',
        traySummary.backgroundPaused ? '后台执行已暂停。' : '后台执行未暂停。',
        createdAt,
        'warning',
        {
          label: '查看托盘摘要',
          action: 'open_lifecycle_panel'
        }
      ),
      this.finding(
        'rtk.binary',
        rtkStatus.resourceState === 'ready',
        'RTK 二进制',
        rtkStatus.resourceState === 'ready' ? rtkStatus.binaryPath : '第一版尚未随包提供 roc-rtk.exe。',
        createdAt,
        'warning',
        {
          label: '打开 RTK 诊断',
          action: 'open_rtk_diagnostics'
        }
      ),
      this.performanceFinding(latestPerformance, createdAt)
    ];

    const runId = `doctor_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    this.database.db.prepare('INSERT INTO doctor_runs (id, generated_at) VALUES (?, ?)').run(runId, createdAt);
    const insertFinding = this.database.db.prepare(
      `INSERT INTO doctor_findings (id, run_id, check_id, severity, status, title, detail, repair_action_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const finding of findings) {
      insertFinding.run(
        finding.id,
        runId,
        finding.checkId,
        finding.severity,
        finding.status,
        finding.title,
        finding.detail,
        finding.repairAction === undefined ? null : JSON.stringify(finding.repairAction),
        finding.createdAt
      );
    }

    return {
      generatedAt: createdAt,
      summary: this.summarize(findings),
      findings
    };
  }

  private finding(
    checkId: string,
    passed: boolean,
    title: string,
    detail: string,
    createdAt: string,
    degradedSeverity: DoctorFinding['severity'] = 'error',
    repairAction?: DoctorFinding['repairAction']
  ): DoctorFinding {
    return {
      id: `finding_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
      checkId,
      severity: passed ? 'info' : degradedSeverity,
      status: passed ? 'pass' : 'degraded',
      title,
      detail,
      repairAction,
      createdAt
    };
  }

  private performanceFinding(sample: ReturnType<DiagnosticsService['getLatestPerformanceSample']>, createdAt: string): DoctorFinding {
    if (sample === null) {
      return {
        id: `finding_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
        checkId: 'performance.sample',
        severity: 'warning',
        status: 'skipped',
        title: '性能采样',
        detail: '尚未生成性能采样。',
        repairAction: {
          label: '重新采样',
          action: 'sample_performance'
        },
        createdAt
      };
    }

    return {
      id: `finding_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
      checkId: 'performance.sample',
      severity: sample.exceedsBudget ? 'warning' : 'info',
      status: sample.exceedsBudget ? 'degraded' : 'pass',
      title: '性能采样',
      detail: `RSS ${sample.rssMb} MB，预算 ${sample.memoryBudgetMb} MB。`,
      repairAction: {
        label: '重新采样',
        action: 'sample_performance'
      },
      createdAt
    };
  }

  private summarize(findings: DoctorFinding[]): DoctorSnapshot['summary'] {
    return {
      pass: findings.filter((item) => item.status === 'pass').length,
      fail: findings.filter((item) => item.status === 'fail').length,
      degraded: findings.filter((item) => item.status === 'degraded').length,
      skipped: findings.filter((item) => item.status === 'skipped').length
    };
  }
}
