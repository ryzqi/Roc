import type {
  AgentLangSmithConfigV1,
  AgentLangSmithSettings
} from '../../../shared/types';
import { agentLangSmithConfigSchema } from '../../../shared/schemas/agent';

const configKey = 'langsmith.settings';
const apiKeySecretKey = 'langsmith.apiKey';

type ConfigFacade = {
  get<T>(key: string): T | null;
  set<T>(key: string, value: T): void;
};

type SecretFacade = {
  get(key: string): string | null;
  set(key: string, plaintext: string): void;
  clear(key: string): void;
};

export { agentLangSmithConfigSchema };

export const defaultAgentLangSmithConfig: AgentLangSmithConfigV1 = {
  schemaVersion: 1,
  enabled: false,
  projectName: 'roc'
};

export type AgentLangSmithRuntimeSettings = {
  config: AgentLangSmithConfigV1;
  apiKey: string;
};

export class AgentLangSmithSettingsStore {
  constructor(
    private readonly config: ConfigFacade,
    private readonly secrets: SecretFacade
  ) {}

  initialize(): AgentLangSmithConfigV1 {
    return this.readConfig();
  }

  getSnapshot(): AgentLangSmithSettings {
    return {
      config: this.readConfig(),
      apiKeyStored: this.hasApiKey()
    };
  }

  saveConfig(input: AgentLangSmithConfigV1): AgentLangSmithSettings {
    const config = parseConfig(input);
    if (config.enabled) {
      this.requireApiKey();
    }
    this.config.set(configKey, config);
    return {
      config,
      apiKeyStored: this.hasApiKey()
    };
  }

  setApiKey(input: string): AgentLangSmithSettings {
    const config = this.readConfig();
    const apiKey = input.trim();
    if (apiKey.length === 0) {
      throw new Error('agent_langsmith_api_key_empty');
    }
    this.secrets.set(apiKeySecretKey, apiKey);
    return {
      config,
      apiKeyStored: true
    };
  }

  clearApiKey(): AgentLangSmithSettings {
    const config = this.readConfig();
    if (config.enabled) {
      throw new Error('agent_langsmith_disable_before_secret_clear');
    }
    this.secrets.clear(apiKeySecretKey);
    return {
      config,
      apiKeyStored: false
    };
  }

  getRuntimeSettings(): AgentLangSmithRuntimeSettings | null {
    const config = this.readConfig();
    if (!config.enabled) {
      return null;
    }
    return {
      config,
      apiKey: this.requireApiKey()
    };
  }

  private readConfig(): AgentLangSmithConfigV1 {
    const persisted = this.config.get<unknown>(configKey);
    if (persisted === null) {
      const initialized = { ...defaultAgentLangSmithConfig };
      this.config.set(configKey, initialized);
      return initialized;
    }
    return parseConfig(persisted);
  }

  private hasApiKey(): boolean {
    const apiKey = this.secrets.get(apiKeySecretKey);
    return apiKey !== null && apiKey.trim().length > 0;
  }

  private requireApiKey(): string {
    const apiKey = this.secrets.get(apiKeySecretKey);
    if (apiKey === null || apiKey.trim().length === 0) {
      throw new Error('agent_langsmith_api_key_missing');
    }
    return apiKey.trim();
  }
}

function parseConfig(input: unknown): AgentLangSmithConfigV1 {
  const parsed = agentLangSmithConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error('agent_langsmith_config_invalid');
  }
  return parsed.data;
}
