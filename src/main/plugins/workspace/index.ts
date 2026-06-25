import { z } from 'zod';

import type {
  FileDeleteResult,
  FilePreviewRequest,
  FilePreviewResult,
  FileSearchRequest,
  FileSearchResult,
  FileTreeRequest,
  FileTreeResult,
  FilesWorkbenchPdfPreviewRequest,
  FilesWorkbenchPdfPreviewResult,
  FileWriteResult,
  FileWriteTextRequest,
  GitBatchFileOperationRequest,
  GitBranchListResult,
  GitBranchMutationResult,
  GitCheckoutBranchRequest,
  GitCommitRequest,
  GitCommitResult,
  GitCreateBranchRequest,
  GitDiffStatResult,
  GitFileDiffResult,
  GitFileOperationRequest,
  GitPushResult,
  GitStatusResult,
  RocSettingsDocument,
  TerminalSessionCloseRequest,
  TerminalSessionCreateRequest,
  TerminalSessionInputRequest,
  TerminalSessionResizeRequest,
  TerminalSessionSnapshot,
  Workspace,
  WorkspaceSelectRequest
} from '../../../shared/types';
import type { CapabilityDescriptor, EventSubscription, RocPlugin, RocPluginContext } from '../../kernel/types';
import { defaultSettings } from '../../services/config/defaults';
import { FileService, type FileRecoveryPointDatabase } from '../../services/file-service';
import { GitService } from '../../services/git-service';
import { RocPaths } from '../../services/paths';
import { TerminalSessionService } from '../../services/terminal-session-service';
import { WorkspaceChangeWatcherService } from '../../services/workspace-change-watcher-service';
import { WorkspaceService, type WorkspaceConfigService } from '../../services/workspace-service';
import { registerFileCapabilities } from './file-capabilities';
import { registerGitCapabilities } from './git-capabilities';
import {
  registerTerminalCapabilities,
  terminalSessionExitEventType,
  terminalSessionOutputEventType
} from './terminal-capabilities';

const pluginId = '@roc/plugin-workspace';
const capabilityVersion = '1.0.0';
export const workspaceChangedEventType = 'workspace.changed';

const workspaceSelectRequestSchema = z.object({
  path: z.string()
}) satisfies z.ZodType<WorkspaceSelectRequest>;

const fileTreeRequestSchema = z.object({
  relativePath: z.string(),
  limit: z.number().int().optional()
}) satisfies z.ZodType<FileTreeRequest>;

const fileSearchRequestSchema = z.object({
  query: z.string(),
  maxResults: z.number().int().optional()
}) satisfies z.ZodType<FileSearchRequest>;

const filePreviewRequestSchema = z.object({
  relativePath: z.string(),
  maxBytes: z.number().int().optional()
}) satisfies z.ZodType<FilePreviewRequest>;

const fileWriteTextRequestSchema = z.object({
  relativePath: z.string(),
  content: z.string(),
  source: z.string(),
  threadId: z.string().optional(),
  runId: z.string().optional()
}) satisfies z.ZodType<FileWriteTextRequest>;

const gitFileOperationRequestSchema = z.object({
  relativePath: z.string()
}) satisfies z.ZodType<GitFileOperationRequest>;

const gitBatchFileOperationRequestSchema = z.object({
  relativePaths: z.array(z.string())
}) satisfies z.ZodType<GitBatchFileOperationRequest>;

const gitCommitRequestSchema = z.object({
  message: z.string()
}) satisfies z.ZodType<GitCommitRequest>;

const gitCreateBranchRequestSchema = z.object({
  name: z.string(),
  checkoutAfterCreate: z.boolean()
}) satisfies z.ZodType<GitCreateBranchRequest>;

const gitCheckoutBranchRequestSchema = z.object({
  name: z.string()
}) satisfies z.ZodType<GitCheckoutBranchRequest>;

const terminalSessionCreateRequestSchema = z.object({
  cwd: z.string().optional(),
  cols: z.number(),
  rows: z.number()
}) satisfies z.ZodType<TerminalSessionCreateRequest>;

const terminalSessionInputRequestSchema = z.object({
  sessionId: z.string(),
  data: z.string()
}) satisfies z.ZodType<TerminalSessionInputRequest>;

const terminalSessionResizeRequestSchema = z.object({
  sessionId: z.string(),
  cols: z.number(),
  rows: z.number()
}) satisfies z.ZodType<TerminalSessionResizeRequest>;

const terminalSessionCloseRequestSchema = z.object({
  sessionId: z.string()
}) satisfies z.ZodType<TerminalSessionCloseRequest>;

const relativePathRequestSchema = z.object({
  relativePath: z.string()
});

const emptyInputSchema = z.object({});

const workspaceCapabilityDescriptors = [
  descriptor('workspace.getCurrent', emptyInputSchema, z.custom<Workspace | null>()),
  descriptor('workspace.select', workspaceSelectRequestSchema, z.custom<Workspace>()),
  descriptor('files.listTree', fileTreeRequestSchema, z.custom<FileTreeResult>()),
  descriptor('files.search', fileSearchRequestSchema, z.custom<FileSearchResult>()),
  descriptor('files.preview', filePreviewRequestSchema, z.custom<FilePreviewResult>()),
  descriptor('files.previewPdf', relativePathRequestSchema satisfies z.ZodType<FilesWorkbenchPdfPreviewRequest>, z.custom<FilesWorkbenchPdfPreviewResult>()),
  descriptor('files.writeText', fileWriteTextRequestSchema, z.custom<FileWriteResult>()),
  descriptor('files.delete', relativePathRequestSchema, z.custom<FileDeleteResult>()),
  descriptor('git.status', emptyInputSchema, z.custom<GitStatusResult>()),
  descriptor('git.diffStat', emptyInputSchema, z.custom<GitDiffStatResult>()),
  descriptor('git.fileDiff', gitFileOperationRequestSchema, z.custom<GitFileDiffResult>()),
  descriptor('git.stageFile', gitFileOperationRequestSchema, z.custom<GitStatusResult>()),
  descriptor('git.stageFiles', gitBatchFileOperationRequestSchema, z.custom<GitStatusResult>()),
  descriptor('git.unstageFile', gitFileOperationRequestSchema, z.custom<GitStatusResult>()),
  descriptor('git.discardFile', gitFileOperationRequestSchema, z.custom<GitStatusResult>()),
  descriptor('git.commit', gitCommitRequestSchema, z.custom<GitCommitResult>()),
  descriptor('git.push', emptyInputSchema, z.custom<GitPushResult>()),
  descriptor('git.listBranches', emptyInputSchema, z.custom<GitBranchListResult>()),
  descriptor('git.createBranch', gitCreateBranchRequestSchema, z.custom<GitBranchMutationResult>()),
  descriptor('git.checkoutBranch', gitCheckoutBranchRequestSchema, z.custom<GitBranchMutationResult>()),
  descriptor('terminal.createSession', terminalSessionCreateRequestSchema, z.custom<TerminalSessionSnapshot>()),
  descriptor('terminal.writeInput', terminalSessionInputRequestSchema, z.object({ delivered: z.literal(true) })),
  descriptor('terminal.resize', terminalSessionResizeRequestSchema, z.custom<TerminalSessionSnapshot>()),
  descriptor('terminal.closeSession', terminalSessionCloseRequestSchema, z.object({ closed: z.literal(true) })),
  descriptor('files.streamPdfPreviewResource', relativePathRequestSchema, z.custom<Response>())
] as const satisfies readonly CapabilityDescriptor[];

export type WorkspacePluginOptions = {
  rootDir?: string;
  workspaceConfigService?: WorkspaceConfigService;
};

export function createWorkspacePlugin(options: WorkspacePluginOptions = {}): RocPlugin {
  let terminalService: TerminalSessionService | null = null;
  let workspaceChangeWatcher: WorkspaceChangeWatcherService | null = null;
  let unsubscribeTerminalOutput: EventSubscription | null = null;
  let unsubscribeTerminalExit: EventSubscription | null = null;
  return {
    manifest: {
      id: pluginId,
      version: '1.0.0',
      displayName: 'Workspace',
      description: 'Roc workspace plugin.',
      loadPhase: 'critical',
      required: true,
      order: 40,
      dependencies: [],
      capabilities: workspaceCapabilityDescriptors
    },
    initialize: async (context) => {
      const paths = new RocPaths(options.rootDir);
      paths.ensureTree();
      applyWorkspacePluginSchema(context.database.getConnection());
      const workspaceService = new WorkspaceService(options.workspaceConfigService ?? createWorkspaceConfigAdapter(context));
      const fileService = new FileService(paths, createFileDatabaseAdapter(context), workspaceService);
      const gitService = new GitService(workspaceService);
      workspaceChangeWatcher = new WorkspaceChangeWatcherService({
        logger: context.logger,
        onChange: (event) =>
          context.eventBus.publish({
            type: workspaceChangedEventType,
            source: pluginId,
            payload: event,
            createdAt: new Date().toISOString()
          })
      });
      const currentWorkspace = workspaceService.getCurrentWorkspace();
      workspaceChangeWatcher.setWorkspace(currentWorkspace === null ? null : currentWorkspace.path);
      terminalService = new TerminalSessionService(paths, workspaceService);
      unsubscribeTerminalOutput = terminalService.onOutput((payload) => {
        void context.eventBus.publish({
          type: terminalSessionOutputEventType,
          source: pluginId,
          payload,
          createdAt: new Date().toISOString()
        }).catch((error: unknown) => {
          context.logger.error('Workspace terminal output event publish failed.', {
            error: error instanceof Error ? error.message : String(error)
          });
        });
      });
      unsubscribeTerminalExit = terminalService.onExit((payload) => {
        void context.eventBus.publish({
          type: terminalSessionExitEventType,
          source: pluginId,
          payload,
          createdAt: new Date().toISOString()
        }).catch((error: unknown) => {
          context.logger.error('Workspace terminal exit event publish failed.', {
            error: error instanceof Error ? error.message : String(error)
          });
        });
      });

      context.capabilities.register(pluginId, workspaceCapabilityDescriptors[0], async () =>
        workspaceService.getCurrentWorkspace()
      );
      context.capabilities.register(pluginId, workspaceCapabilityDescriptors[1], async (input) => {
        const workspace = workspaceService.selectWorkspace((input as WorkspaceSelectRequest).path);
        workspaceChangeWatcher?.setWorkspace(workspace.path);
        return workspace;
      });
      registerFileCapabilities(context, workspaceCapabilityDescriptors.slice(2, 8), fileService);
      registerGitCapabilities(context, workspaceCapabilityDescriptors.slice(8, 20), gitService);
      registerTerminalCapabilities(context, workspaceCapabilityDescriptors.slice(20, 24), terminalService);
      context.capabilities.register(pluginId, workspaceCapabilityDescriptors[24], async (input) =>
        fileService.streamPdfPreviewResource((input as { relativePath: string }).relativePath)
      );
    },
    shutdown: async () => {
      if (unsubscribeTerminalOutput !== null) {
        unsubscribeTerminalOutput();
      }
      if (unsubscribeTerminalExit !== null) {
        unsubscribeTerminalExit();
      }
      unsubscribeTerminalOutput = null;
      unsubscribeTerminalExit = null;
      if (terminalService !== null) {
        terminalService.shutdown();
      }
      terminalService = null;
      if (workspaceChangeWatcher !== null) {
        workspaceChangeWatcher.shutdown();
      }
      workspaceChangeWatcher = null;
    },
    healthCheck: async () => ({ status: 'healthy' })
  };
}

export { workspaceCapabilityDescriptors };

function createWorkspaceConfigAdapter(context: RocPluginContext): WorkspaceConfigService {
  return {
    getSettings: () => {
      const settings = context.config.get<RocSettingsDocument['settings']>('settings');
      if (settings !== null) {
        return settings;
      }
      return {
        ...defaultSettings,
        defaultWorkspace: context.config.get<string>('defaultWorkspace')
      };
    },
    saveSettings: (settings) => {
      context.config.set('settings', settings);
      context.config.set('defaultWorkspace', settings.defaultWorkspace);
    }
  };
}

function createFileDatabaseAdapter(context: RocPluginContext): FileRecoveryPointDatabase {
  return {
    get db() {
      return context.database.getConnection();
    }
  };
}

function applyWorkspacePluginSchema(db: ReturnType<RocPluginContext['database']['getConnection']>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS recovery_points (
      id TEXT PRIMARY KEY,
      relative_path TEXT NOT NULL,
      snapshot_path TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      restored INTEGER NOT NULL
    );
  `);
}

function descriptor<TInput, TOutput>(
  name: string,
  inputSchema: z.ZodType<TInput>,
  outputSchema: z.ZodType<TOutput>
): CapabilityDescriptor<TInput, TOutput> {
  return {
    name,
    version: capabilityVersion,
    inputSchema,
    outputSchema
  };
}
