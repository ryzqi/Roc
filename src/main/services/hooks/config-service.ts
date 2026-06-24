import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  rocHookEventNames,
  type RocHookConfig,
  type RocHookConfigSnapshot,
  type RocHookConfiguredHandlerSnapshot,
  type RocHookTrustRequest,
  type RocHookTrustState
} from '../../../shared/types';
import type { RocPaths } from '../paths';
import { computeHookHandlerHash, createHookHandlerId } from './hash';
import { EmptyHookConfig, HookConfigSchema } from './schema';

type HookTrustReader = {
  isTrusted(request: RocHookTrustRequest): Promise<boolean>;
};

export class HookConfigService {
  constructor(
    private readonly paths: RocPaths,
    private readonly trustService?: HookTrustReader
  ) {}

  getConfigPath(): string {
    return join(this.paths.root, 'hooks.json');
  }

  async loadConfig(): Promise<RocHookConfig> {
    const configPath = this.getConfigPath();
    if (!existsSync(configPath)) {
      return createEmptyHookConfig();
    }
    const raw = await readFile(configPath, 'utf8');
    return HookConfigSchema.parse(JSON.parse(raw));
  }

  async loadConfigSnapshot(): Promise<RocHookConfigSnapshot> {
    const configPath = this.getConfigPath();
    if (!existsSync(configPath)) {
      return {
        configPath,
        exists: false,
        config: createEmptyHookConfig(),
        handlers: [],
        validationErrors: []
      };
    }
    try {
      const config = await this.loadConfig();
      const validationErrors: string[] = [];
      return {
        configPath,
        exists: true,
        config,
        handlers: await buildHandlerSnapshots(config, this.trustService, (error) => addValidationError(validationErrors, formatError(error))),
        validationErrors
      };
    } catch (error) {
      return {
        configPath,
        exists: true,
        config: createEmptyHookConfig(),
        handlers: [],
        validationErrors: [formatError(error)]
      };
    }
  }

  async saveConfig(config: RocHookConfig): Promise<RocHookConfigSnapshot> {
    const parsed = HookConfigSchema.parse(config);
    await mkdir(this.paths.root, { recursive: true });
    await writeFile(this.getConfigPath(), `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    return await this.loadConfigSnapshot();
  }
}

export async function buildHandlerSnapshots(
  config: RocHookConfig,
  trustService?: HookTrustReader,
  onTrustError?: (error: unknown) => void
): Promise<RocHookConfiguredHandlerSnapshot[]> {
  const snapshots: RocHookConfiguredHandlerSnapshot[] = [];
  for (const event of rocHookEventNames) {
    const groups = config.hooks[event];
    if (groups === undefined) {
      continue;
    }
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      const group = groups[groupIndex];
      for (let hookIndex = 0; hookIndex < group.hooks.length; hookIndex += 1) {
        const handler = group.hooks[hookIndex];
        const matcher = group.matcher === undefined ? null : group.matcher;
        const id = createHookHandlerId({ event, groupIndex, hookIndex });
        const hash = computeHookHandlerHash({ event, matcher, handler });
        snapshots.push({
          id,
          event,
          matcher,
          command: handler.command,
          commandWindows: handler.commandWindows === undefined ? null : handler.commandWindows,
          timeoutSeconds: handler.timeoutSeconds,
          statusMessage: handler.statusMessage === undefined ? null : handler.statusMessage,
          enabled: handler.enabled,
          failureMode: handler.failureMode,
          hash,
          trustState: await readTrustState({ handlerId: id, hash, enabled: handler.enabled, trustService, onTrustError }),
          validationError: null,
          lastRun: null
        });
      }
    }
  }
  return snapshots;
}

function createEmptyHookConfig(): RocHookConfig {
  return {
    schemaVersion: EmptyHookConfig.schemaVersion,
    hooks: {}
  };
}

async function readTrustState(input: {
  handlerId: string;
  hash: string;
  enabled: boolean;
  trustService?: HookTrustReader;
  onTrustError?: (error: unknown) => void;
}): Promise<RocHookTrustState> {
  if (!input.enabled) {
    return 'disabled';
  }
  if (input.trustService === undefined) {
    return 'review_required';
  }
  try {
    if (await input.trustService.isTrusted({ handlerId: input.handlerId, hash: input.hash })) {
      return 'trusted';
    }
  } catch (error) {
    if (input.onTrustError !== undefined) {
      input.onTrustError(error);
    }
  }
  return 'review_required';
}

function addValidationError(errors: string[], message: string): void {
  if (!errors.includes(message)) {
    errors.push(message);
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
