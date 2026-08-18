import {
  pluginCapabilityMappings,
  type GeneratedPluginCapabilityMapping
} from '../../shared/ipc';
import type { IpcResult } from '../../shared/types';
import { wrapIpc } from '../services/errors';
import type { TimedHandle } from './ipc-common';

export type PluginCapabilityDomain = GeneratedPluginCapabilityMapping['domain'];

export type PluginCapabilityInvoker = {
  invokeCapability<TInput, TOutput>(name: string, input: TInput): Promise<TOutput>;
};

export type PluginCapabilityMapping = GeneratedPluginCapabilityMapping;

export type PluginCapabilityAdapter = {
  invoke(preloadMethod: string, args: readonly unknown[]): Promise<IpcResult<unknown>>;
};

export { pluginCapabilityMappings };

export function createPluginCapabilityAdapter(invoker: PluginCapabilityInvoker): PluginCapabilityAdapter {
  const mappingsByMethod = new Map<string, PluginCapabilityMapping>(
    pluginCapabilityMappings.map((item) => [item.preloadMethod, item])
  );
  return {
    async invoke(preloadMethod, args) {
      const target = mappingsByMethod.get(preloadMethod);
      if (target === undefined) {
        return await wrapIpc(() => {
          throw new Error(`plugin_capability_mapping_missing:${preloadMethod}`);
        });
      }
      return await wrapIpc(async () =>
        await invoker.invokeCapability(target.capabilityName, transformInput(target.inputTransform, args))
      );
    }
  };
}

export function registerPluginCapabilityIpc(timedHandle: TimedHandle, invoker: PluginCapabilityInvoker): void {
  const adapter = createPluginCapabilityAdapter(invoker);
  for (const target of pluginCapabilityMappings) {
    timedHandle(target.channel, (_event: unknown, ...args: unknown[]) => adapter.invoke(target.preloadMethod, args));
  }
}

function transformInput(
  transform: PluginCapabilityMapping['inputTransform'],
  args: readonly unknown[]
): unknown {
  if (transform.kind === 'none') {
    if (args.length !== 0) {
      throw new Error('ipc_capability_expected_no_args');
    }
    return {};
  }
  if (transform.kind === 'optional-first') {
    return args.length === 0 ? {} : firstArg(args);
  }
  if (transform.kind === 'first') {
    return firstArg(args);
  }
  if (transform.kind === 'id') {
    const value = firstArg(args);
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error('ipc_capability_id_arg_invalid');
    }
    return { [transform.key]: value };
  }
  return assertNeverInputTransform(transform);
}

function assertNeverInputTransform(transform: never): never {
  throw new Error(`ipc_capability_input_transform_invalid:${String(transform)}`);
}

function firstArg(args: readonly unknown[]): unknown {
  const value = args[0];
  if (value === undefined) {
    throw new Error('ipc_capability_missing_arg');
  }
  return value;
}
