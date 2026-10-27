import { z } from 'zod';

import {
  rtkStatusSchema,
  shellConfirmationRequestSchema,
  shellConfirmationResultSchema,
  shellExecutionResultSchema
} from '../../../shared/schemas/ipc-workspace';
import type {
  ShellConfirmationRequest,
  ShellConfirmationResult,
  ShellExecutionRequest
} from '../../../shared/types';
import type { RTKBinaryManager } from '../../../rtk-integration';
import type { CapabilityDescriptor, RocPlugin } from '../../kernel/types';
import type { WorkspaceService } from '../../services/workspace-service';
import { WebReadService, type WebReadExecutionRequest, type WebReadResult } from '../../services/web-read-service';
import { RocPaths } from '../../services/paths';
import { RtkService } from '../../services/rtk-service';
import { webReadExecutionRequestSchema } from '../../services/web-read-request-schema';
import {
  createShellExecutionService,
  type ShellCommandExecutor
} from './shell-adapter';

const pluginId = '@roc/plugin-runtime-tools';
const capabilityVersion = '1.0.0';

const emptyInputSchema = z.object({});
const shellExecutionRequestSchema = z.object({
  command: z.string(),
  cwd: z.string().optional(),
  source: z.enum(['agent', 'terminal']),
  threadId: z.string().optional(),
  runId: z.string().optional(),
  signal: z.custom<AbortSignal>().optional(),
  allowedCommands: z.array(z.string().trim().min(1)).optional()
}).strict() satisfies z.ZodType<ShellExecutionRequest>;
const webReadResultSchema = z.object({
  content: z.string().min(1),
  source: z.string().url(),
  proxy: z.literal('https://r.jina.ai/'),
  fetchedAt: z.string().min(1),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  untrusted: z.literal(true)
}) satisfies z.ZodType<WebReadResult>;

const runtimeToolsCapabilityDescriptors = [
  descriptor('rtk.status', emptyInputSchema, rtkStatusSchema),
  descriptor('shell.execute', shellExecutionRequestSchema, shellExecutionResultSchema),
  descriptor('shell.confirm', shellConfirmationRequestSchema, shellConfirmationResultSchema),
  descriptor('web.read', webReadExecutionRequestSchema, webReadResultSchema)
] as const satisfies readonly CapabilityDescriptor[];

export type RuntimeToolsPluginOptions = {
  rootDir?: string;
  workspacePath?: string;
  /**
   * The shell's working-directory binding. When the shell hands over the instance it owns,
   * `shell.execute` without an explicit `cwd` resolves the bound directory; a private instance
   * would never see `workspace.select` and would always answer `workspace_not_selected`.
   */
  workspaceService?: WorkspaceService;
  binaryManager?: RTKBinaryManager;
  commandExecutor?: ShellCommandExecutor;
  confirmShellRequest?: (request: ShellConfirmationRequest) => Promise<ShellConfirmationResult>;
  fetchImpl?: ConstructorParameters<typeof WebReadService>[0];
};

export function createRuntimeToolsPlugin(options: RuntimeToolsPluginOptions = {}): RocPlugin {
  return {
    manifest: {
      id: pluginId,
      version: '1.0.0',
      displayName: 'Runtime Tools',
      description: 'Roc runtime tools plugin.',
      required: true,
      order: 70,
      dependencies: [],
      capabilities: runtimeToolsCapabilityDescriptors
    },
    initialize: async (context) => {
      const paths = new RocPaths(options.rootDir);
      paths.ensureTree();
      const rtkService = new RtkService(paths, options.binaryManager);
      const shellService = createShellExecutionService({
        workspacePath: options.workspacePath,
        workspaceService: options.workspaceService,
        rtkService,
        commandExecutor: options.commandExecutor
      });
      const webReadService = new WebReadService(options.fetchImpl);
      context.capabilities.register(pluginId, runtimeToolsCapabilityDescriptors[0], async () => rtkService.getStatus());
      context.capabilities.register(pluginId, runtimeToolsCapabilityDescriptors[1], async (input) =>
        shellService.executeAsync(input as ShellExecutionRequest)
      );
      context.capabilities.register(pluginId, runtimeToolsCapabilityDescriptors[2], async (input) =>
        confirmShell(input as ShellConfirmationRequest, options.confirmShellRequest)
      );
      context.capabilities.register(pluginId, runtimeToolsCapabilityDescriptors[3], async (input) =>
        webReadService.read(input as WebReadExecutionRequest)
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
