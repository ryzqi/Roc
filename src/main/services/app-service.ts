import type { AppStatus, RocRunMode, SystemAppearanceSnapshot } from '../../shared/types';
import { AgentService } from './agent-service';
import { ConfigService } from './config-service';
import { DatabaseService } from './database-service';
import { DeepAgentRuntimeService } from './deep-agent-runtime-service';
import { DiagnosticsService, type RuntimeMetricsProvider } from './diagnostics-service';
import { FileService } from './file-service';
import { GitService } from './git-service';
import { LifecycleService } from './lifecycle-service';
import { LogService } from './log-service';
import { LangChainModelFactory } from './langchain-model-factory';
import { McpService } from './mcp-service';
import { MemoryService } from './memory-service';
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

export class AppService {
  readonly startedAt = new Date().toISOString();

  constructor(
    private readonly paths: RocPaths,
    private readonly configService: ConfigService,
    private readonly databaseService: DatabaseService,
    private readonly memoryService: MemoryService,
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
    this.logService.append({ level: 'info', message: 'Roc critical services initialized.' });
  }

  initializeDeferred(): void {
    this.memoryService.initialize();
    this.taskSchedulerService.start();
    this.logService.append({ level: 'info', message: 'Roc deferred services initialized.' });
  }

  shutdown(): void {
    this.terminalSessionService.shutdown();
    this.taskSchedulerService.stop();
    this.databaseService.close();
  }

  getStatus(): AppStatus {
    const settings = this.configService.getSettings();

    return {
      appName: 'Roc Windows Super Assistant',
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
  const memoryService = new MemoryService(paths, databaseService, workspaceService, () => configService.getSettings().memory);
  const rtkService = new RtkService(paths);
  const performanceObserverService = new PerformanceObserverService();
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
  const webReadService = new WebReadService();
  const shellExecutionService = new ShellExecutionService(workspaceService, rtkService, taskService);
  const fileService = new FileService(paths, databaseService, workspaceService);
  const deepAgentRuntimeService = new DeepAgentRuntimeService(
    langChainModelFactory,
    taskService,
    databaseService,
    agentService,
    workspaceService,
    fileService,
    mcpService,
    webReadService,
    shellExecutionService,
    paths,
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
