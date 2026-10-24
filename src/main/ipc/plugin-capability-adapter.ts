import { withLiteratureContext } from '../services/literature-context';
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
  invoke(preloadMethod: string, args: readonly unknown[], windowId?: number): Promise<IpcResult<unknown>>;
};

export { pluginCapabilityMappings };

export function createPluginCapabilityAdapter(invoker: PluginCapabilityInvoker): PluginCapabilityAdapter {
  const mappingsByMethod = new Map<string, PluginCapabilityMapping>(
    pluginCapabilityMappings.map((item) => [item.preloadMethod, item])
  );
  return {
    async invoke(preloadMethod, args, windowId = 0) {
      const target = mappingsByMethod.get(preloadMethod);
      if (target === undefined) {
        return await wrapIpc(() => {
          throw new Error(`plugin_capability_mapping_missing:${preloadMethod}`);
        });
      }
      return await wrapIpc(async () => {
        const input = transformInput(target.inputTransform, args);
        const scoped = ['research.literature.search', 'research.literature.getSearch', 'research.library.addLiterature',
          'research.library.getImportOperation', 'research.library.cancelImportOperation'].includes(target.capabilityName);
        if (!scoped) return invoker.invokeCapability(target.capabilityName, input);
        const projectId = typeof input === 'object' && input !== null && !Array.isArray(input) && 'projectId' in input && typeof input.projectId === 'string' ? input.projectId : null;
        return withLiteratureContext({ owner: `window:${windowId}`, projectId }, () => invoker.invokeCapability(target.capabilityName, input));
      });
    }
  };
}

export function registerPluginCapabilityIpc(timedHandle: TimedHandle, invoker: PluginCapabilityInvoker): void {
  const adapter = createPluginCapabilityAdapter(invoker);
  for (const target of pluginCapabilityMappings) {
    timedHandle(target.channel, (event: { sender: { id: number } }, ...args: unknown[]) => adapter.invoke(target.preloadMethod, args, event.sender.id));
  }
}

/**
 * A value that crossed the preload boundary. The capability's own zod input schema validates it, so
 * this type only has to be honest about the wire format: JSON values, never functions.
 */
type IpcArgumentValue =
  | string
  | number
  | boolean
  | null
  | readonly IpcArgumentValue[]
  | { readonly [key: string]: IpcArgumentValue };

function transformInput(
  transform: PluginCapabilityMapping['inputTransform'],
  args: readonly unknown[]
): IpcArgumentValue {
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

function firstArg(args: readonly unknown[]): IpcArgumentValue {
  const value = args[0];
  if (value === undefined) {
    throw new Error('ipc_capability_missing_arg');
  }
  // Decode at the boundary: everything below this point has been through the preload bridge, and
  // the capability's input schema is the real validator.
  return value as IpcArgumentValue;
}
