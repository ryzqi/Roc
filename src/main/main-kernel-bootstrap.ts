import { join } from 'node:path';

import type { AgentRuntimeStatus } from '../shared/types';
import type { RuntimeMetricsProvider } from './services/diagnostics-service';
import type { SafeStorageBackend } from './infrastructure/secret-manager';
import { KernelRuntime } from './kernel/kernel-runtime';
import type { RocPlugin } from './kernel/types';
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
      safeStorage: options.safeStorage
    });
  const runtime = new KernelRuntime({
    rootDir: pluginDataDir,
    plugins,
    safeStorage: options.safeStorage
  });
  const activateMigration = options.activateMigration ?? activateMainKernelMigration;

  return {
    paths,
    runtime,
    performanceObserverService,
    async start() {
      paths.ensureTree();
      const activatedPluginDataDir = await activateMigration({
        paths,
        pluginDataDir,
        sourceDatabasePath: paths.databasePath
      });
      if (activatedPluginDataDir !== pluginDataDir) {
        throw new Error('kernel_plugin_data_root_mismatch');
      }
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
  return input.pluginDataDir;
}

function createDefaultMainKernelPlugins(input: {
  paths: RocPaths;
  safeStorage: SafeStorageBackend;
  performanceObserverService: PerformanceObserverService;
  runtimeMetricsProvider?: RuntimeMetricsProvider;
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
