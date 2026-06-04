import { z } from 'zod';

import type {
  McpServerConfig,
  McpServerSnapshot,
  McpServerTestResult,
  McpServersConfig
} from '../../../shared/types';
import type { CapabilityDescriptor, RocPlugin, RocPluginContext } from '../../kernel/types';
import { defaultMcpConfig } from '../../services/config/defaults';
import { McpServerSchema } from '../../services/config/schema';
import { McpService, type McpConfigService } from '../../services/mcp-service';
import { createMcpClientAdapter, type McpClientAdapter } from './mcp-client-adapter';

const pluginId = '@roc/plugin-mcp';
const capabilityVersion = '1.0.0';

const emptyInputSchema = z.object({});
const serverEnabledRequestSchema = z.object({
  id: z.string(),
  enabled: z.boolean()
});
const idInputSchema = z.object({
  id: z.string()
});

const mcpCapabilityDescriptors = [
  descriptor('mcp.listServers', emptyInputSchema, z.custom<McpServerSnapshot[]>()),
  descriptor('mcp.upsertServer', McpServerSchema, z.custom<McpServerConfig>()),
  descriptor('mcp.setServerEnabled', serverEnabledRequestSchema, z.custom<McpServerConfig>()),
  descriptor('mcp.deleteServer', idInputSchema, z.object({ deleted: z.literal(true) })),
  descriptor('mcp.testServer', idInputSchema, z.custom<McpServerTestResult>()),
  descriptor('mcp.tools.get', emptyInputSchema, z.array(z.unknown()))
] as const satisfies readonly CapabilityDescriptor[];

export type McpPluginOptions = {
  clientAdapter?: McpClientAdapter;
};

export function createMcpPlugin(options: McpPluginOptions = {}): RocPlugin {
  const clientAdapter = options.clientAdapter ?? createMcpClientAdapter();
  return {
    manifest: {
      id: pluginId,
      version: '1.0.0',
      displayName: 'MCP',
      description: 'Roc MCP plugin.',
      loadPhase: 'critical',
      required: true,
      order: 50,
      dependencies: [],
      capabilities: mcpCapabilityDescriptors
    },
    initialize: async (context) => {
      const configAdapter = createConfigAdapter(context);
      const service = new McpService(configAdapter);
      service.ensureExaPreset();
      context.capabilities.register(pluginId, mcpCapabilityDescriptors[0], async () => service.listServers());
      context.capabilities.register(pluginId, mcpCapabilityDescriptors[1], async (input) =>
        service.upsertServer(input as McpServerConfig)
      );
      context.capabilities.register(pluginId, mcpCapabilityDescriptors[2], async (input) => {
        const request = input as { id: string; enabled: boolean };
        return service.setServerEnabled(request.id, request.enabled);
      });
      context.capabilities.register(pluginId, mcpCapabilityDescriptors[3], async (input) => {
        service.deleteServer((input as { id: string }).id);
        return { deleted: true as const };
      });
      context.capabilities.register(pluginId, mcpCapabilityDescriptors[4], async (input) =>
        service.testServer((input as { id: string }).id)
      );
      context.capabilities.register(pluginId, mcpCapabilityDescriptors[5], async () =>
        clientAdapter.loadTools(configAdapter.getMcpConfig().servers.filter((server) => server.enabled))
      );
    },
    shutdown: async () => {
      await clientAdapter.close();
    },
    healthCheck: async () => ({ status: 'healthy' })
  };
}

export const mcpPlugin = createMcpPlugin();
export { mcpCapabilityDescriptors };

function createConfigAdapter(context: RocPluginContext): McpConfigService {
  return {
    getMcpConfig: () => {
      const config = context.config.get<McpServersConfig>('mcp');
      if (config === null) {
        return cloneDefaultMcpConfig();
      }
      return config;
    },
    saveMcpConfig: (config) => {
      context.config.set('mcp', config);
    }
  };
}

function cloneDefaultMcpConfig(): McpServersConfig {
  return {
    schemaVersion: defaultMcpConfig.schemaVersion,
    servers: [...defaultMcpConfig.servers]
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
