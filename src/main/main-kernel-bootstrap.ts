import { join } from 'node:path';

import type { AgentRuntimeStatus, AppStatus, SystemAppearanceSnapshot } from '../shared/types';
import type { RuntimeMetricsProvider } from './services/diagnostics-service';
import type { SafeStorageBackend } from './infrastructure/secret-manager';
import { activatePluginDataMigration } from './infrastructure/migration/monolith-to-plugins';
import { KernelRuntime } from './kernel/kernel-runtime';
import type { RocPlugin } from './kernel/types';
import { createAppPlugin } from './plugins/app';
import { LangChainAgentModelFactoryAdapter } from './plugins/agent/model-factory-adapter';
import { createAgentPlugin } from './plugins/agent';
import { createDiagnosticsPlugin } from './plugins/diagnostics';
import { createMcpPlugin } from './plugins/mcp';
import { createMemoryPlugin } from './plugins/memory';
import { createRuntimeToolsPlugin } from './plugins/runtime-tools';
import { createSkillsPlugin } from './plugins/skills';
import { createTaskPlugin } from './plugins/task';
import { createWorkspacePlugin } from './plugins/workspace';
import { ConfigService } from './services/config-service';
import { LangChainModelFactory } from './services/langchain-model-factory';
import { LogService } from './services/log-service';
import { PerformanceObserverService } from './services/performance-observer-service';
import { RocPaths } from './services/paths';
import { SecretService } from './services/secret-service';

export type MainKernelMigrationInput = {
  paths: RocPaths;
  pluginDataDir: string;
  sourceDatabasePath: string;
};

export type MainKernelMigrationActivator = (input: MainKernelMigrationInput) => string | Promise<string>;

export type MainKernelBootstrapOptions = {
  dataRoot?: string;
  safeStorage: SafeStorageBackend;
  plugins?: readonly RocPlugin[];
  activateMigration?: MainKernelMigrationActivator;
  performanceObserverService?: PerformanceObserverService;
  runtimeMetricsProvider?: RuntimeMetricsProvider;
  version?: string;
  isPackaged?: boolean;
  getAppearance?: () => SystemAppearanceSnapshot;
};

export type MainKernelBootstrap = {
  readonly paths: RocPaths;
  readonly runtime: KernelRuntime;
  readonly performanceObserverService: PerformanceObserverService;
  start(): Promise<void>;
  shutdown(): Promise<void>;
  invokeCapability<TInput, TOutput>(name: string, input: TInput): Promise<TOutput>;
};

export function createMainKernelBootstrap(options: MainKernelBootstrapOptions): MainKernelBootstrap {
  const paths = new RocPaths(options.dataRoot);
  const pluginDataDir = join(paths.root, 'plugin-data');
  const performanceObserverService = options.performanceObserverService ?? new PerformanceObserverService();
  const plugins =
    options.plugins ??
    createDefaultMainKernelPlugins({
      paths,
      performanceObserverService,
      runtimeMetricsProvider: options.runtimeMetricsProvider,
      version: options.version,
      isPackaged: options.isPackaged,
      getAppearance: options.getAppearance,
      safeStorage: options.safeStorage
    });
  const activateMigration = options.activateMigration ?? activateMainKernelMigration;
  const runtime = new KernelRuntime({
    activateMigration: async () => {
      const activatedPluginDataDir = await activateMigration({
        paths,
        pluginDataDir,
        sourceDatabasePath: paths.databasePath
      });
      if (activatedPluginDataDir !== pluginDataDir) {
        throw new Error('kernel_plugin_data_root_mismatch');
      }
    },
    rootDir: pluginDataDir,
    plugins,
    safeStorage: options.safeStorage
  });

  return {
    paths,
    runtime,
    performanceObserverService,
    async start() {
      paths.ensureTree();
      await runtime.start();
    },
    async shutdown() {
      await runtime.shutdown();
    },
    async invokeCapability<TInput, TOutput>(name: string, input: TInput): Promise<TOutput> {
      return await runtime.invokeCapability<TInput, TOutput>(name, input);
    }
  };
}

export function activateMainKernelMigration(input: MainKernelMigrationInput): string {
  return activatePluginDataMigration({
    pluginDataDir: input.pluginDataDir,
    sourceDatabasePath: input.sourceDatabasePath
  }).pluginDataDir;
}

function createDefaultMainKernelPlugins(input: {
  paths: RocPaths;
  safeStorage: SafeStorageBackend;
  performanceObserverService: PerformanceObserverService;
  runtimeMetricsProvider?: RuntimeMetricsProvider;
  version?: string;
  isPackaged?: boolean;
  getAppearance?: () => SystemAppearanceSnapshot;
}): readonly RocPlugin[] {
  input.paths.ensureTree();
  const configService = new ConfigService(input.paths);
  configService.initialize();
  const logService = new LogService(input.paths);
  logService.initialize();
  const secretService = new SecretService(input.paths, input.safeStorage);
  const modelFactory = new LangChainModelFactory(configService, secretService, logService);
  const defaultWorkspace = configService.getSettings().defaultWorkspace;

  return [
    createAppPlugin({
      statusProvider: () =>
        createAppStatus({
          configService,
          defaultWorkspace,
          getAppearance: input.getAppearance,
          isPackaged: input.isPackaged === true,
          paths: input.paths,
          version: input.version === undefined ? '0.1.0' : input.version
        })
    }),
    createAgentPlugin({
      modelFactory: new LangChainAgentModelFactoryAdapter(modelFactory),
      status: createAgentRuntimeStatus(configService)
    }),
    createMemoryPlugin({
      memoryRoot: input.paths.memoryDir,
      workspace: defaultWorkspace === null ? null : { path: defaultWorkspace, label: defaultWorkspace }
    }),
    createTaskPlugin(),
    createWorkspacePlugin({ rootDir: input.paths.root }),
    createMcpPlugin(),
    createSkillsPlugin({ rootDir: input.paths.root }),
    createRuntimeToolsPlugin({
      rootDir: input.paths.root,
      workspacePath: defaultWorkspace === null ? undefined : defaultWorkspace
    }),
    createDiagnosticsPlugin({
      rootDir: input.paths.root,
      runtimeMetricsProvider: input.runtimeMetricsProvider
    })
  ];
}

function createAppStatus(input: {
  configService: ConfigService;
  defaultWorkspace: string | null;
  getAppearance?: () => SystemAppearanceSnapshot;
  isPackaged: boolean;
  paths: RocPaths;
  version: string;
}): AppStatus {
  const workspaceLabel = input.defaultWorkspace === null ? '未选择工作区' : input.defaultWorkspace;
  const workspaceReady = input.defaultWorkspace === null ? 'blocked' : 'ready';
  return {
    appName: 'Roc',
    version: input.version,
    mode: detectMode(input.isPackaged),
    startedAt: new Date().toISOString(),
    appearance: input.getAppearance === undefined ? defaultAppearance() : input.getAppearance(),
    workspace: {
      selectedPath: input.defaultWorkspace,
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
