export type NvidiaModelFamily =
  | 'qwen'
  | 'glm'
  | 'kimi'
  | 'granite'
  | 'deepseek'
  | 'nemotron'
  | 'gpt-oss'
  | 'llama'
  | 'mistral'
  | 'unknown';

export function resolveNvidiaModelFamily(modelId: string): NvidiaModelFamily {
  const normalizedModelId = modelId.trim().toLowerCase();
  if (normalizedModelId.startsWith('qwen/qwen3')) {
    return 'qwen';
  }
  if (normalizedModelId.startsWith('zai-org/glm') || normalizedModelId.startsWith('z-ai/glm')) {
    return 'glm';
  }
  if (normalizedModelId.startsWith('moonshotai/kimi-k2')) {
    return 'kimi';
  }
  if (normalizedModelId.startsWith('ibm/granite-3')) {
    return 'granite';
  }
  if (
    normalizedModelId.startsWith('deepseek-ai/deepseek-v3') ||
    normalizedModelId.startsWith('deepseek-ai/deepseek-v4') ||
    normalizedModelId.startsWith('deepseek-ai/deepseek-r')
  ) {
    return 'deepseek';
  }
  if (normalizedModelId.startsWith('nvidia/llama-3.') && normalizedModelId.includes('-nemotron-')) {
    return 'nemotron';
  }
  if (normalizedModelId.startsWith('openai/gpt-oss-')) {
    return 'gpt-oss';
  }
  if (normalizedModelId.startsWith('meta/llama-')) {
    return 'llama';
  }
  if (normalizedModelId.startsWith('mistralai/')) {
    return 'mistral';
  }
  return 'unknown';
}

export function nvidiaThinkingParameterName(family: NvidiaModelFamily): 'enable_thinking' | 'thinking' | null {
  if (family === 'qwen' || family === 'glm') {
    return 'enable_thinking';
  }
  if (family === 'kimi' || family === 'granite' || family === 'deepseek') {
    return 'thinking';
  }
  return null;
}

export function nvidiaSupportsThinkingViaSystemPrompt(family: NvidiaModelFamily): boolean {
  return family === 'nemotron';
}
