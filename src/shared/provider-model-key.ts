export type ProviderModelKey = {
  providerId: string;
  modelId: string;
};

export function buildProviderModelKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

export function parseProviderModelKey(value: string): ProviderModelKey | null {
  const separatorIndex = value.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    return null;
  }
  const providerId = value.slice(0, separatorIndex);
  const modelId = value.slice(separatorIndex + 1);
  return { providerId, modelId };
}
