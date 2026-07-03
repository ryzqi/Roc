import { join } from 'node:path';

import type { AgentRuntimeStatus, AppStatus, SettingsSaveRequest, SystemAppearanceSnapshot } from '../shared/types';
import { setLogService } from './services/errors';
import type { SafeStorageBackend } from './infrastructure/secret-manager';
import { deleteLegacyMonolithData } from './infrastructure/legacy-data-cleanup';
import { KernelRuntime } from './kernel/kernel-runtime';
import type { EventSubscription, RocEventEnvelope, RocPlugin } from './kernel/types';
import { createAppPlugin } from './plugins/app';
import { LangChainAgentModelFactoryAdapter } from './plugins/agent/model-factory-adapter';
import { createAgentPlugin } from './plugins/agent';
import { createDiagnosticsPlugin } from './plugins/diagnostics';
import type { RuntimeMetricsProvider } from './plugins/diagnostics/runtime-metrics';
import { createMcpPlugin } from './plugins/mcp';
import { createMemoryPlugin } from './plugins/memory';
import { createRuntimeToolsPlugin } from './plugins/runtime-tools';
import { createSkillsPlugin } from './plugins/skills';
import { createTaskPlugin } from './plugins/task';
import { createWorkspacePlugin } from './plugins/workspace';
import { ConfigService } from './services/config-service';
import { HookCommandRunner, HookConfigService, HookRuntime, HookTrustService } from './services/hooks';
import { LangChainModelFactory } from './services/langchain-model-factory';
import { LogService } from './services/log-service';
import { MetricsService } from './services/metrics-service';
import { PerformanceObserverService } from './services/performance-observer-service';
import { RocPaths } from './services/paths';
import { ProviderRuntimeService } from './services/provider-runtime-service';
import { SecretService } from './services/secret-service';

export type MainKernelBootstrapOptions = {
  dataRoot?: string;
  safeStorage: SafeStorageBackend;
  plugins?: readonly RocPlugin[];
  performanceObserverService?: PerformanceObserverService;
  runtimeMetricsProvider?: RuntimeMetricsProvider;
  version?: string;
  isPackaged?: boolean;
  getAppearance?: () => SystemAppearanceSnapshot;
};

export type MainKernelBootstrap = {
  readonly paths: RocPaths;
  readonly runtime: KernelRuntime;
  readonly configService: ConfigService;
  readonly hookConfigService: HookConfigService;
  readonly hookTrustService: HookTrustService;
  readonly logService: LogService;
  readonly secretService: SecretService;
  readonly providerRuntimeService: ProviderRuntimeService;
  readonly performanceObserverService: PerformanceObserverService;
  start(): Promise<void>;
  shutdown(): Promise<void>;
  syncSettingsSnapshot(request: SettingsSaveRequest): void;
  invokeCapability<TInput, TOutput>(name: string, input: TInput): Promise<TOutput>;
  subscribeEvent<TPayload>(
    type: string,
    handler: (event: RocEventEnvelope<TPayload>) => void | Promise<void>
  ): EventSubscription;
};

export function createMainKernelBootstrap(options: MainKernelBootstrapOptions): MainKernelBootstrap {
  const paths = new RocPaths(options.dataRoot);
  const pluginDataDir = join(paths.root, 'plugin-data');
  const performanceObserverService = options.performanceObserverService ?? new PerformanceObserverService();
  paths.ensureTree();
  const configService = new ConfigService(paths);
  configService.initialize();
  const hookTrustService = new HookTrustService(paths);
  const hookConfigService = new HookConfigService(paths, hookTrustService);
  const hookRuntime = new HookRuntime({
    configService: hookConfigService,
    trustService: hookTrustService,
    commandRunner: new HookCommandRunner()
  });
  const logService = new LogService(paths);
  logService.initialize();
  setLogService(logService);
  const secretService = new SecretService(paths, options.safeStorage);
  const metricsService = new MetricsService();
  const modelFactory = new LangChainModelFactory(configService, secretService, logService);
  const providerRuntimeService = new ProviderRuntimeService(configService, modelFactory, metricsService);
  const plugins =
    options.plugins ??
    createDefaultMainKernelPlugins({
      configService,
      hookRuntime,
      metricsService,
      modelFactory,
      paths,
      performanceObserverService,
      runtimeMetricsProvider: options.runtimeMetricsProvider,
      version: options.version,
      isPackaged: options.isPackaged,
      getAppearance: options.getAppearance
    });
  const runtime = new KernelRuntime({
    activateMigration: async () => {
      await deleteLegacyMonolithData(paths.root);
    },
    rootDir: pluginDataDir,
    plugins,
    safeStorage: options.safeStorage
  });

  return {
    paths,
    runtime,
    configService,
    hookConfigService,
    hookTrustService,
    logService,
    secretService,
    providerRuntimeService,
    performanceObserverService,
    async start() {
      paths.ensureTree();
      await runtime.start();
    },
    async shutdown() {
      try {
        await runtime.shutdown();
      } finally {
        setLogService(null);
        await logService.close();
      }
    },
    syncSettingsSnapshot(request) {
      void request;
      configService.reloadSettingsDocument();
    },
    async invokeCapability<TInput, TOutput>(name: string, input: TInput): Promise<TOutput> {
      return await runtime.invokeCapability<TInput, TOutput>(name, input);
    },
    subscribeEvent<TPayload>(
      type: string,
      handler: (event: RocEventEnvelope<TPayload>) => void | Promise<void>
    ): EventSubscription {
      return runtime.subscribeEvent(type, handler);
    }
  };
}

function createDefaultMainKernelPlugins(input: {
  paths: RocPaths;
  configService: ConfigService;
  hookRuntime: HookRuntime;
  metricsService: MetricsService;
  modelFactory: LangChainModelFactory;
  performanceObserverService: PerformanceObserverService;
  runtimeMetricsProvider?: RuntimeMetricsProvider;
  version?: string;
  isPackaged?: boolean;
  getAppearance?: () => SystemAppearanceSnapshot;
}): readonly RocPlugin[] {
  input.paths.ensureTree();
  const configService = input.configService;
  const defaultWorkspace = configService.getSettings().defaultWorkspace;

  return [
    createAppPlugin({
      statusProvider: () => {
        configService.reloadSettingsDocument();
        return createAppStatus({
          configService,
          getAppearance: input.getAppearance,
          isPackaged: input.isPackaged === true,
          paths: input.paths,
          version: input.version === undefined ? '0.1.0' : input.version
        });
      }
    }),
    createAgentPlugin({
      capabilityPreview: {
        deleteFileApprovalModeProvider: () => {
          configService.reloadSettingsDocument();
          return configService.getPermissions().mode;
        },
        mcpApprovalModeProvider: () => {
          configService.reloadSettingsDocument();
          return configService.getMcpConfig().approvalMode;
        }
      },
      deepAgentExecutor: {
        getMemorySettings: () => {
          configService.reloadSettingsDocument();
          return configService.getSettings().memory;
        },
        hookRuntime: input.hookRuntime,
        metricsService: input.metricsService,
        paths: input.paths
      },
      modelFactory: new LangChainAgentModelFactoryAdapter(input.modelFactory, {
        beforeCreate: () => {
          configService.reloadSettingsDocument();
        }
      }),
      statusProvider: () => {
        configService.reloadSettingsDocument();
        return createAgentRuntimeStatus(configService);
      }
    }),
    createMemoryPlugin({
      getWorkspace: () => {
        configService.reloadSettingsDocument();
        const workspacePath = configService.getSettings().defaultWorkspace;
        return workspacePath === null ? null : { path: workspacePath, label: workspacePath };
      },
      getMemorySettings: () => {
        configService.reloadSettingsDocument();
        return configService.getSettings().memory;
      }
    }),
    createTaskPlugin(),
    createWorkspacePlugin({ rootDir: input.paths.root, workspaceConfigService: configService }),
    createMcpPlugin({ configService }),
    createSkillsPlugin({ rootDir: input.paths.root }),
    createRuntimeToolsPlugin({
      rootDir: input.paths.root,
      workspaceConfigService: configService,
      workspacePath: defaultWorkspace === null ? undefined : defaultWorkspace
    }),
    createDiagnosticsPlugin({
      performanceObserverService: input.performanceObserverService,
      rootDir: input.paths.root,
      runtimeMetricsProvider: input.runtimeMetricsProvider
    })
  ];
}

function createAppStatus(input: {
  configService: ConfigService;
  getAppearance?: () => SystemAppearanceSnapshot;
  isPackaged: boolean;
  paths: RocPaths;
  version: string;
}): AppStatus {
  const defaultWorkspace = input.configService.getSettings().defaultWorkspace;
  const workspaceLabel = defaultWorkspace === null ? '未选择工作区' : defaultWorkspace;
  const workspaceReady = defaultWorkspace === null ? 'blocked' : 'ready';
  return {
    appName: 'Roc',
    version: input.version,
    mode: detectMode(input.isPackaged),
    startedAt: new Date().toISOString(),
    appearance: input.getAppearance === undefined ? defaultAppearance() : input.getAppearance(),
    workspace: {
      selectedPath: defaultWorkspace,
      label: workspaceLabel
    },
    paths: input.paths.snapshot(),
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
      agent: input.configService.hasDefaultModel() ? 'ready' : 'blocked',
      workspace: workspaceReady,
      files: workspaceReady,
      git: workspaceReady,
      terminal: workspaceReady,
      rtk: 'ready'
    },
    defaultModelConfigured: input.configService.hasDefaultModel(),
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

function detectMode(isPackaged: boolean): AppStatus['mode'] {
  if (process.env.VITEST === 'true') {
    return 'test';
  }
  if (process.env.ROC_SMOKE === '1') {
    return 'smoke';
  }
  if (isPackaged) {
    return 'packaged';
  }
  return 'development';
}

function defaultAppearance(): SystemAppearanceSnapshot {
  return {
    accentColor: '#0078d4',
    inForcedColorsMode: false,
    prefersReducedTransparency: false,
    resolvedTheme: 'dark',
    shouldUseHighContrastColors: false,
    shouldUseInvertedColorScheme: false,
    themeSource: 'system'
  };
}

function createAgentRuntimeStatus(configService: ConfigService): AgentRuntimeStatus {
  const defaultModelState = configService.getDefaultModelState();
  const defaultModelConfigured = defaultModelState.status === 'ready';
  return {
    deepAgentsPackage: 'available',
    deepAgentsApi: {
      createDeepAgent: true
    },
    defaultModelConfigured,
    defaultModelState,
    memoryAccess: 'store_backend',
    execution: defaultModelConfigured ? 'ready' : 'blocked_until_provider_configured'
  };
}
