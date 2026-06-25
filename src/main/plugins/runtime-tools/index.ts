import { z } from 'zod';

import type {
  RtkStatus,
  ShellConfirmationRequest,
  ShellConfirmationResult,
  ShellExecutionRequest,
  ShellExecutionResult
} from '../../../shared/types';
import type { RTKBinaryManager } from '../../../rtk-integration';
import type { CapabilityDescriptor, RocPlugin } from '../../kernel/types';
import type { WorkspaceConfigService } from '../../services/workspace-service';
import type { WebReadRequest } from '../../services/web-read-service';
import { webReadRequestSchema } from '../../services/web-read-request-schema';
import { createRtkService } from './rtk-adapter';
import {
  createShellExecutionService,
  type ShellCommandExecutor
} from './shell-adapter';
import { createWebReadService, type WebReadAdapterOptions } from './web-read-adapter';

const pluginId = '@roc/plugin-runtime-tools';
const capabilityVersion = '1.0.0';

const emptyInputSchema = z.object({});
const shellExecutionRequestSchema = z.object({
  command: z.string(),
  cwd: z.string().optional(),
  source: z.enum(['agent', 'terminal']),
  threadId: z.string().optional(),
  runId: z.string().optional()
}) satisfies z.ZodType<ShellExecutionRequest>;
const shellConfirmationRequestSchema = z.object({
  title: z.string(),
  message: z.string(),
  confirmLabel: z.string(),
  cancelLabel: z.string()
}) satisfies z.ZodType<ShellConfirmationRequest>;
const shellConfirmationResultSchema = z.object({
  confirmed: z.boolean(),
  response: z.number().int()
}) satisfies z.ZodType<ShellConfirmationResult>;

const runtimeToolsCapabilityDescriptors = [
  descriptor('rtk.status', emptyInputSchema, z.custom<RtkStatus>()),
  descriptor('shell.execute', shellExecutionRequestSchema, z.custom<ShellExecutionResult>()),
  descriptor('shell.confirm', shellConfirmationRequestSchema, shellConfirmationResultSchema),
  descriptor('web.read', webReadRequestSchema, z.string())
] as const satisfies readonly CapabilityDescriptor[];

export type RuntimeToolsPluginOptions = {
  rootDir?: string;
  workspacePath?: string;
  workspaceConfigService?: WorkspaceConfigService;
  binaryManager?: RTKBinaryManager;
  commandExecutor?: ShellCommandExecutor;
  confirmShellRequest?: (request: ShellConfirmationRequest) => Promise<ShellConfirmationResult>;
  fetchImpl?: WebReadAdapterOptions['fetchImpl'];
};

export function createRuntimeToolsPlugin(options: RuntimeToolsPluginOptions = {}): RocPlugin {
  return {
    manifest: {
      id: pluginId,
      version: '1.0.0',
      displayName: 'Runtime Tools',
      description: 'Roc runtime tools plugin.',
      loadPhase: 'critical',
      required: true,
      order: 70,
      dependencies: [],
      capabilities: runtimeToolsCapabilityDescriptors
    },
    initialize: async (context) => {
      const rtkService = createRtkService({
        rootDir: options.rootDir,
        binaryManager: options.binaryManager
      });
      const shellService = createShellExecutionService({
        rootDir: options.rootDir,
        workspacePath: options.workspacePath,
        workspaceConfigService: options.workspaceConfigService,
        rtkService,
        commandExecutor: options.commandExecutor
      });
      const webReadService = createWebReadService({ fetchImpl: options.fetchImpl });
      context.capabilities.register(pluginId, runtimeToolsCapabilityDescriptors[0], async () => rtkService.getStatus());
      context.capabilities.register(pluginId, runtimeToolsCapabilityDescriptors[1], async (input) =>
        shellService.executeAsync(input as ShellExecutionRequest)
      );
      context.capabilities.register(pluginId, runtimeToolsCapabilityDescriptors[2], async (input) =>
        confirmShell(input as ShellConfirmationRequest, options.confirmShellRequest)
      );
      context.capabilities.register(pluginId, runtimeToolsCapabilityDescriptors[3], async (input) =>
        webReadService.read(input as WebReadRequest)
      );
    },
    shutdown: async () => {},
    healthCheck: async () => ({ status: 'healthy' })
  };
}

async function confirmShell(
  request: ShellConfirmationRequest,
  confirmShellRequest: RuntimeToolsPluginOptions['confirmShellRequest']
): Promise<ShellConfirmationResult> {
  if (confirmShellRequest !== undefined) {
    return await confirmShellRequest(request);
  }
  return {
    confirmed: false,
    response: 1
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
