import { join } from 'node:path';
import type { AppStatus, RocRunMode, SystemAppearanceSnapshot } from '../../shared/types';
import { AgentService } from './agent-service';
import { ConfigService } from './config-service';
import { DatabaseService } from './database-service';
import { DeepAgentRuntimeService } from './deep-agent-runtime-service';
import { DiagnosticsService, type RuntimeMetricsProvider } from './diagnostics-service';
import { setLogService } from './errors';
import { FileService } from './file-service';
import { GitService } from './git-service';
import { LifecycleService } from './lifecycle-service';
import { LogService } from './log-service';
import { LangChainModelFactory } from './langchain-model-factory';
import { McpService } from './mcp-service';
import { MetricsService } from './metrics-service';
import { MemoryService } from './memory-service';
import { ConsolidatorService } from './memory/consolidator';
import { PrecompactionService } from './memory/precompaction';
import { SessionArchiveService } from './memory/session-archive';
import { RocPaths } from './paths';
import { ProviderRuntimeService } from './provider-runtime-service';
import { PerformanceObserverService } from './performance-observer-service';
import { RtkService } from './rtk-service';
import { createRuntimeCapabilityResolver } from './runtime-capability-resolver';
import { SecretService, type SafeStorageBackend } from './secret-service';
import { ShellExecutionService } from './shell-execution-service';
import { SkillService } from './skill-service';
import { TaskService } from './task-service';
import { TaskSchedulerService } from './task-scheduler-service';
import { TerminalSessionService } from './terminal-session-service';
import { WebReadService } from './web-read-service';
import { WorkspaceService } from './workspace-service';

export type AppServices = {
  appService: AppService;
  paths: RocPaths;
  configService: ConfigService;
  databaseService: DatabaseService;
  memoryService: MemoryService;
  consolidatorService: ConsolidatorService;
  precompactionService: PrecompactionService;
  sessionArchiveService: SessionArchiveService;
  taskService: TaskService;
  taskSchedulerService: TaskSchedulerService;
  lifecycleService: LifecycleService;
  diagnosticsService: DiagnosticsService;
  mcpService: McpService;
  skillService: SkillService;
  agentService: AgentService;
  langChainModelFactory: LangChainModelFactory;
  deepAgentRuntimeService: DeepAgentRuntimeService;
  providerRuntimeService: ProviderRuntimeService;
  performanceObserverService: PerformanceObserverService;
  metricsService: MetricsService;
  logService: LogService;
  workspaceService: WorkspaceService;
  fileService: FileService;
  gitService: GitService;
  terminalSessionService: TerminalSessionService;
  webReadService: WebReadService;
  rtkService: RtkService;
  shellExecutionService: ShellExecutionService;
  secretService: SecretService;
};

export type RuntimeEnvironment = {
  version: string;
  isPackaged: boolean;
  getAppearance: () => SystemAppearanceSnapshot;
};

const defaultRuntimeEnvironment: RuntimeEnvironment = {
  version: '0.1.0',
  isPackaged: false,
  getAppearance: () => ({
    accentColor: '#2d477a',
    inForcedColorsMode: false,
    prefersReducedTransparency: false,
    resolvedTheme: 'light',
    shouldUseHighContrastColors: false,
    shouldUseInvertedColorScheme: false,
    themeSource: 'system'
  })
};

const memoryRetentionSweepIntervalMs = 24 * 60 * 60 * 1000;

export class AppService {
  readonly startedAt = new Date().toISOString();
  private memoryRetentionSweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly paths: RocPaths,
    private readonly configService: ConfigService,
    private readonly databaseService: DatabaseService,
    private readonly memoryService: MemoryService,
    private readonly consolidatorService: ConsolidatorService,
    private readonly precompactionService: PrecompactionService,
    private readonly sessionArchiveService: SessionArchiveService,
    private readonly taskService: TaskService,
    private readonly taskSchedulerService: TaskSchedulerService,
    private readonly lifecycleService: LifecycleService,
    private readonly diagnosticsService: DiagnosticsService,
    private readonly mcpService: McpService,
    private readonly skillService: SkillService,
    private readonly agentService: AgentService,
    private readonly langChainModelFactory: LangChainModelFactory,
    private readonly deepAgentRuntimeService: DeepAgentRuntimeService,
    private readonly providerRuntimeService: ProviderRuntimeService,
    private readonly performanceObserverService: PerformanceObserverService,
    private readonly metricsService: MetricsService,
    private readonly workspaceService: WorkspaceService,
    private readonly fileService: FileService,
    private readonly gitService: GitService,
    private readonly terminalSessionService: TerminalSessionService,
    private readonly webReadService: WebReadService,
    private readonly rtkService: RtkService,
    private readonly shellExecutionService: ShellExecutionService,
    private readonly logService: LogService,
    private readonly runtimeEnvironment: RuntimeEnvironment
  ) {}

  initialize(): void {
    this.initializeCritical();
    this.initializeDeferred();
  }

  initializeCritical(): void {
    this.paths.ensureTree();
    this.configService.initialize();
    this.mcpService.ensureExaPreset();
    this.databaseService.initialize();
    this.logService.initialize();
    setLogService(this.logService);
    this.logService.info('Roc critical services initialized.', {
      service: 'app-service',
      component: 'initializeCritical'
    });
  }

  initializeDeferred(): void {
    this.memoryService.initialize();
    this.runMemoryRetentionSweep();
    this.startMemoryRetentionSweepTimer();
    this.taskSchedulerService.start();
    this.logService.info('Roc deferred services initialized.', {
      service: 'app-service',
      component: 'initializeDeferred'
    });
  }

  async shutdown(): Promise<void> {
    this.terminalSessionService.shutdown();
    this.stopMemoryRetentionSweepTimer();
    this.taskSchedulerService.stop();
    this.databaseService.close();
    await this.logService.close();
    setLogService(null);
  }

  getStatus(): AppStatus {
    const settings = this.configService.getSettings();

    return {
      appName: 'Roc',
      version: this.runtimeEnvironment.version,
      mode: this.detectMode(),
      startedAt: this.startedAt,
      appearance: this.runtimeEnvironment.getAppearance(),
      workspace: {
        selectedPath: settings.defaultWorkspace,
        label: settings.defaultWorkspace === null ? '未选择工作区' : settings.defaultWorkspace
      },
      paths: this.paths.snapshot(),
      services: {
        app: 'ready',
        config: 'ready',
        database: 'ready',
        memory: 'ready',
        tasks: 'ready',
        lifecycle: 'ready',
        diagnostics: 'ready',
        mcp: 'ready',
        skills: 'ready',
        agent: this.agentService.getStatus().defaultModelConfigured ? 'ready' : 'blocked',
        workspace: this.workspaceService.getCurrentWorkspace() === null ? 'blocked' : 'ready',
        files: this.workspaceService.getCurrentWorkspace() === null ? 'blocked' : 'ready',
        git: this.workspaceService.getCurrentWorkspace() === null ? 'blocked' : 'ready',
        terminal: this.workspaceService.getCurrentWorkspace() === null ? 'blocked' : 'ready',
        rtk: this.rtkService.getStatus().resourceState === 'ready' ? 'ready' : 'degraded'
      },
      defaultModelConfigured: this.configService.hasDefaultModel(),
      rendererBoundary: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: {
          enabled: false,
          evaluated: true,
          reason: 'Electron sandbox blocks the current bundled ESM preload; smoke timed out before renderer root appeared.',
          compensatingControls: ['contextIsolation', 'nodeIntegration=false', 'typed preload API', 'external URL scheme allowlist']
        }
      }
    };
  }

  get services(): Omit<
    AppServices,
    'appService' | 'paths' | 'configService' | 'databaseService' | 'logService' | 'secretService'
  > {
    return {
      memoryService: this.memoryService,
      consolidatorService: this.consolidatorService,
      precompactionService: this.precompactionService,
      sessionArchiveService: this.sessionArchiveService,
      taskService: this.taskService,
      taskSchedulerService: this.taskSchedulerService,
      lifecycleService: this.lifecycleService,
      diagnosticsService: this.diagnosticsService,
      mcpService: this.mcpService,
      skillService: this.skillService,
      agentService: this.agentService,
      langChainModelFactory: this.langChainModelFactory,
      deepAgentRuntimeService: this.deepAgentRuntimeService,
      providerRuntimeService: this.providerRuntimeService,
      performanceObserverService: this.performanceObserverService,
      metricsService: this.metricsService,
      workspaceService: this.workspaceService,
      fileService: this.fileService,
      gitService: this.gitService,
      terminalSessionService: this.terminalSessionService,
      webReadService: this.webReadService,
      rtkService: this.rtkService,
      shellExecutionService: this.shellExecutionService
    };
  }

  private detectMode(): RocRunMode {
    if (process.env.VITEST === 'true') {
      return 'test';
    }
    if (process.env.ROC_SMOKE === '1') {
      return 'smoke';
    }
    if (this.runtimeEnvironment.isPackaged) {
      return 'packaged';
    }
    return 'development';
  }

  private runMemoryRetentionSweep(): void {
    const retentionDays = this.configService.getSettings().memory.sessionRetentionDays;
    this.sessionArchiveService.sweepRetention(retentionDays);
  }

  private startMemoryRetentionSweepTimer(): void {
    if (this.memoryRetentionSweepTimer !== null) {
      return;
    }
    this.memoryRetentionSweepTimer = setInterval(() => {
      this.runMemoryRetentionSweep();
    }, memoryRetentionSweepIntervalMs);
    this.memoryRetentionSweepTimer.unref();
  }

  private stopMemoryRetentionSweepTimer(): void {
    if (this.memoryRetentionSweepTimer === null) {
      return;
    }
    clearInterval(this.memoryRetentionSweepTimer);
    this.memoryRetentionSweepTimer = null;
  }
}

export function createAppServices(
  root?: string,
  runtimeEnvironment = defaultRuntimeEnvironment,
  safeStorageBackend: SafeStorageBackend = createInMemorySafeStorageBackend(),
  runtimeMetricsProvider?: RuntimeMetricsProvider
): AppServices {
  const paths = new RocPaths(root);
  const configService = new ConfigService(paths);
  const databaseService = new DatabaseService(paths);
  const logService = new LogService(paths);
  const taskService = new TaskService(databaseService);
  const lifecycleService = new LifecycleService(taskService);
  const mcpService = new McpService(configService);
  const skillService = new SkillService(paths);
  const workspaceService = new WorkspaceService(configService);
  const sessionArchiveService = new SessionArchiveService(databaseService);
  const rtkService = new RtkService(paths);
  const performanceObserverService = new PerformanceObserverService();
  const metricsService = new MetricsService();
  const diagnosticsService = new DiagnosticsService(
    paths,
    databaseService,
    taskService,
    rtkService,
    performanceObserverService,
    runtimeMetricsProvider
  );
  const agentService = new AgentService(configService, mcpService, skillService);
  const secretService = new SecretService(paths, safeStorageBackend);
  const langChainModelFactory = new LangChainModelFactory(configService, secretService);
  const consolidatorService = new ConsolidatorService({
    memoryDir: paths.memoryDir,
    backupDir: join(paths.memoryDir, '.consolidator-backup'),
    resolveCheapModelHandle: (activeHandle) => langChainModelFactory.resolveCheapModelHandle(activeHandle),
    resolveDefaultModelHandle: async () => await langChainModelFactory.createDefaultChatModel({ streaming: false }),
    callLLM: async ({ systemPrompt, content, activeHandle }) => {
      const result = await activeHandle.model.invoke([
        ['system', systemPrompt],
        ['human', content]
      ]);
      return readModelTextContent(result.content);
    },
    getSettings: () => configService.getSettings().memory
  });
  const precompactionService = new PrecompactionService(databaseService, () => configService.getSettings().memory);
  const memoryService = new MemoryService(
    paths,
    databaseService,
    workspaceService,
    consolidatorService,
    () => configService.getSettings().memory
  );
  const webReadService = new WebReadService();
  const shellExecutionService = new ShellExecutionService(workspaceService, rtkService, taskService);
  const fileService = new FileService(paths, databaseService, workspaceService);
  const deepAgentRuntimeService = new DeepAgentRuntimeService(
    langChainModelFactory,
    taskService,
    databaseService,
    memoryService,
    consolidatorService,
    precompactionService,
    sessionArchiveService,
    agentService,
    workspaceService,
    fileService,
    mcpService,
    webReadService,
    shellExecutionService,
    paths,
    () => configService.getSettings().memory,
    performanceObserverService,
    logService
  );
  const providerRuntimeService = new ProviderRuntimeService(configService, langChainModelFactory);
  const taskSchedulerService = new TaskSchedulerService(taskService, deepAgentRuntimeService, {
    capabilityResolver: createRuntimeCapabilityResolver({ configService, skillService })
  });
  deepAgentRuntimeService.attachScheduler(taskSchedulerService);
  lifecycleService.attachScheduler(taskSchedulerService);
  const gitService = new GitService(workspaceService);
  const terminalSessionService = new TerminalSessionService(paths, workspaceService);
  const appService = new AppService(
    paths,
    configService,
    databaseService,
    memoryService,
    consolidatorService,
    precompactionService,
    sessionArchiveService,
    taskService,
    taskSchedulerService,
    lifecycleService,
    diagnosticsService,
    mcpService,
    skillService,
    agentService,
    langChainModelFactory,
    deepAgentRuntimeService,
    providerRuntimeService,
    performanceObserverService,
    metricsService,
    workspaceService,
    fileService,
    gitService,
    terminalSessionService,
    webReadService,
    rtkService,
    shellExecutionService,
    logService,
    runtimeEnvironment
  );

  return {
    appService,
    paths,
    configService,
    databaseService,
    memoryService,
    consolidatorService,
    precompactionService,
    sessionArchiveService,
    taskService,
    taskSchedulerService,
    lifecycleService,
    diagnosticsService,
    mcpService,
    skillService,
    agentService,
    langChainModelFactory,
    deepAgentRuntimeService,
    providerRuntimeService,
    performanceObserverService,
    metricsService,
    logService,
    workspaceService,
    fileService,
    gitService,
    terminalSessionService,
    webReadService,
    rtkService,
    shellExecutionService,
    secretService
  };
}

function readModelTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') {
        textParts.push(block);
        continue;
      }
      if (typeof block === 'object' && block !== null && Reflect.get(block, 'type') === 'text') {
        const text = Reflect.get(block, 'text');
        if (typeof text !== 'string') {
          throw new Error('Consolidator model returned a text block without string text.');
        }
        textParts.push(text);
        continue;
      }
      throw new Error('Consolidator model returned non-text content.');
    }
    return textParts.join('\n');
  }
  throw new Error('Consolidator model returned unsupported content.');
}

function createInMemorySafeStorageBackend(): SafeStorageBackend {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext) => Buffer.from(`roc-test:${plaintext}`, 'utf8'),
    decryptString: (encrypted) => {
      const text = encrypted.toString('utf8');
      if (!text.startsWith('roc-test:')) {
        throw new Error('Encrypted payload was not produced by the in-memory safe storage backend.');
      }
      return text.slice('roc-test:'.length);
    }
  };
}
