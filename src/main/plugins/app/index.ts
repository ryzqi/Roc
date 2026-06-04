import { z } from 'zod';

import type { AppStatus } from '../../../shared/types';
import type { CapabilityDescriptor, RocPlugin } from '../../kernel/types';

const pluginId = '@roc/plugin-app';
const capabilityVersion = '1.0.0';
const emptyInputSchema = z.object({});

const appCapabilityDescriptors = [
  descriptor('app.status.get', emptyInputSchema, z.custom<AppStatus>())
] as const satisfies readonly CapabilityDescriptor[];

export type AppPluginOptions = {
  statusProvider: () => AppStatus;
};

export function createAppPlugin(options: AppPluginOptions): RocPlugin {
  return {
    manifest: {
      id: pluginId,
      version: '1.0.0',
      displayName: 'App',
      description: 'Roc app status plugin.',
      loadPhase: 'critical',
      required: true,
      order: 0,
      dependencies: [],
      capabilities: appCapabilityDescriptors
    },
    initialize: async (context) => {
      context.capabilities.register(pluginId, appCapabilityDescriptors[0], async () => options.statusProvider());
    },
    shutdown: async () => {},
    healthCheck: async () => ({ status: 'healthy' })
  };
}

export { appCapabilityDescriptors };

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
