import { z } from 'zod';

import {
  closedResultSchema,
  deliveredResultSchema
} from '../../../shared/schemas/ipc-core';
import {
  filePdfPreviewRequestSchema,
  filePdfPreviewResultSchema,
  filePreviewRequestSchema,
  filePreviewResultSchema,
  fileSearchRequestSchema,
  fileSearchResultSchema,
  fileTreeRequestSchema,
  fileTreeResultSchema,
  fileWriteResultSchema,
  fileWriteTextRequestSchema,
  gitBatchFileOperationRequestSchema,
  gitBranchListResultSchema,
  gitBranchMutationResultSchema,
  gitCheckoutBranchRequestSchema,
  gitCommitRequestSchema,
  gitCommitResultSchema,
  gitCreateBranchRequestSchema,
  gitDiffStatResultSchema,
  gitFileDiffResultSchema,
  gitFileOperationRequestSchema,
  gitPushResultSchema,
  gitStatusResultSchema,
  terminalSessionCloseRequestSchema,
  terminalSessionCreateRequestSchema,
  terminalSessionInputRequestSchema,
  terminalSessionResizeRequestSchema,
  terminalSessionSnapshotSchema,
  workspaceSchema,
  workspaceSelectRequestSchema
} from '../../../shared/schemas/ipc-workspace';
import type {
  FileDeleteResult,
  RocSettingsDocument,
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

const relativePathRequestSchema = z.object({
  relativePath: z.string()
}).strict();

const emptyInputSchema = z.object({});

const workspaceCapabilityDescriptors = [
  descriptor('workspace.getCurrent', emptyInputSchema, workspaceSchema.nullable()),
  descriptor('workspace.select', workspaceSelectRequestSchema, workspaceSchema),
  descriptor('files.listTree', fileTreeRequestSchema, fileTreeResultSchema),
  descriptor('files.search', fileSearchRequestSchema, fileSearchResultSchema),
  descriptor('files.preview', filePreviewRequestSchema, filePreviewResultSchema),
  descriptor('files.previewPdf', filePdfPreviewRequestSchema, filePdfPreviewResultSchema),
  descriptor('files.writeText', fileWriteTextRequestSchema, fileWriteResultSchema),
  descriptor('files.delete', relativePathRequestSchema, z.custom<FileDeleteResult>()),
  descriptor('git.status', emptyInputSchema, gitStatusResultSchema),
  descriptor('git.diffStat', emptyInputSchema, gitDiffStatResultSchema),
  descriptor('git.fileDiff', gitFileOperationRequestSchema, gitFileDiffResultSchema),
  descriptor('git.stageFile', gitFileOperationRequestSchema, gitStatusResultSchema),
  descriptor('git.stageFiles', gitBatchFileOperationRequestSchema, gitStatusResultSchema),
  descriptor('git.unstageFile', gitFileOperationRequestSchema, gitStatusResultSchema),
  descriptor('git.discardFile', gitFileOperationRequestSchema, gitStatusResultSchema),
  descriptor('git.commit', gitCommitRequestSchema, gitCommitResultSchema),
  descriptor('git.push', emptyInputSchema, gitPushResultSchema),
  descriptor('git.listBranches', emptyInputSchema, gitBranchListResultSchema),
  descriptor('git.createBranch', gitCreateBranchRequestSchema, gitBranchMutationResultSchema),
  descriptor('git.checkoutBranch', gitCheckoutBranchRequestSchema, gitBranchMutationResultSchema),
  descriptor('terminal.createSession', terminalSessionCreateRequestSchema, terminalSessionSnapshotSchema),
  descriptor('terminal.writeInput', terminalSessionInputRequestSchema, deliveredResultSchema),
  descriptor('terminal.resize', terminalSessionResizeRequestSchema, terminalSessionSnapshotSchema),
  descriptor('terminal.closeSession', terminalSessionCloseRequestSchema, closedResultSchema),
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
