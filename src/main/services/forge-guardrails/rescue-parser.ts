export type RescueResult = {
  toolCalls: Array<{ tool: string; args: Record<string, unknown> }>;
  strategy: 'json_fence' | 'rehearsal' | 'qwen_xml' | 'mistral_bracket' | null;
  reasoningText: string | null;
};

const THINK_TAG_RE = /\[THINK\][\s\S]*?\[\/THINK\]|<think>[\s\S]*?<\/think>/g;
const REHEARSAL_RE = /(\w+)\[ARGS\](\{[\s\S]*?\})/g;
const QWEN_FUNCTION_RE = /<function=([^>\s]+)>([\s\S]*?)<\/function>/g;
const QWEN_PARAMETER_RE = /<parameter=([^>\s]+)>([\s\S]*?)(?:<\/parameter>|(?=<parameter=)|(?=<\/function>)|$)/g;
const MISTRAL_BRACKET_RE = /\[TOOL_CALLS\](\w+)\s*(?=\{)/g;

export function rescueToolCall(text: string, availableTools: readonly string[]): RescueResult {
  const reasoningChunks: string[] = [];
  const cleaned = text
    .replace(THINK_TAG_RE, (match) => {
      reasoningChunks.push(stripThinkTagWrapper(match));
      return '';
    })
    .trim();

  const reasoningText = reasoningChunks.length === 0 ? null : reasoningChunks.join('\n').trim();

  if (cleaned.length === 0) {
    return { toolCalls: [], strategy: null, reasoningText };
  }

  const jsonResults = extractJsonToolCalls(cleaned, availableTools);
  if (jsonResults.length > 0) {
    return { toolCalls: jsonResults, strategy: 'json_fence', reasoningText };
  }

  const rehearsalResults = extractRehearsalToolCalls(cleaned, availableTools);
  if (rehearsalResults.length > 0) {
    return { toolCalls: rehearsalResults, strategy: 'rehearsal', reasoningText };
  }

  const qwenResults = extractQwenXmlToolCalls(cleaned, availableTools);
  if (qwenResults.length > 0) {
    return { toolCalls: qwenResults, strategy: 'qwen_xml', reasoningText };
  }

  const mistralResults = extractMistralBracketToolCalls(cleaned, availableTools);
  if (mistralResults.length > 0) {
    return { toolCalls: mistralResults, strategy: 'mistral_bracket', reasoningText };
  }

  return { toolCalls: [], strategy: null, reasoningText };
}

function stripThinkTagWrapper(raw: string): string {
  return raw.replace(/^\[THINK\]/i, '').replace(/\[\/THINK\]$/i, '').replace(/^<think>/i, '').replace(/<\/think>$/i, '').trim();
}

function extractJsonToolCalls(text: string, availableTools: readonly string[]): Array<{ tool: string; args: Record<string, unknown> }> {
  const stripped = text.replace(/```(?:json)?\s*\n?/g, '').replace(/```/g, '');
  const found: Array<{ tool: string; args: Record<string, unknown> }> = [];

  let i = 0;
  while (i < stripped.length) {
    if (stripped[i] === '{') {
      const end = findMatchingBrace(stripped, i);
      if (end === -1) {
        i += 1;
        continue;
      }
      const parsed = tryParseToolCall(stripped.slice(i, end + 1), availableTools);
      if (parsed !== null) {
        found.push(parsed);
        i = end + 1;
        continue;
      }
    }
    i += 1;
  }
  return found;
}

function findMatchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function tryParseToolCall(json: string, availableTools: readonly string[]): { tool: string; args: Record<string, unknown> } | null {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return null;
  }
  const obj = data as Record<string, unknown>;
  const toolName = typeof obj.tool === 'string' ? obj.tool : typeof obj.name === 'string' ? obj.name : null;
  if (toolName === null || !availableTools.includes(toolName)) {
    return null;
  }
  const argsRaw = obj.args ?? obj.arguments ?? {};
  if (typeof argsRaw !== 'object' || argsRaw === null || Array.isArray(argsRaw)) {
    return null;
  }
  return { tool: toolName, args: argsRaw as Record<string, unknown> };
}

function extractRehearsalToolCalls(text: string, availableTools: readonly string[]): Array<{ tool: string; args: Record<string, unknown> }> {
  const found: Array<{ tool: string; args: Record<string, unknown> }> = [];
  for (const match of text.matchAll(REHEARSAL_RE)) {
    const toolName = match[1];
    if (!availableTools.includes(toolName)) {
      continue;
    }
    try {
      const args = JSON.parse(match[2]);
      if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
        found.push({ tool: toolName, args: args as Record<string, unknown> });
      }
    } catch {
      // ignore malformed rehearsal payloads
      continue;
    }
  }
  return found;
}

function extractQwenXmlToolCalls(text: string, availableTools: readonly string[]): Array<{ tool: string; args: Record<string, unknown> }> {
  const found: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const functionRe = new RegExp(QWEN_FUNCTION_RE.source, 'g');
  for (const fnMatch of text.matchAll(functionRe)) {
    const toolName = fnMatch[1].trim();
    if (!availableTools.includes(toolName)) {
      continue;
    }
    const body = fnMatch[2];
    const args: Record<string, unknown> = {};
    const paramRe = new RegExp(QWEN_PARAMETER_RE.source, 'g');
    for (const paramMatch of body.matchAll(paramRe)) {
      const key = paramMatch[1].trim();
      let value = paramMatch[2];
      if (value.startsWith('\n')) {
        value = value.slice(1);
      }
      if (value.endsWith('\n')) {
        value = value.slice(0, -1);
      }
      args[key] = parseQwenParameterValue(value);
    }
    found.push({ tool: toolName, args });
  }
  return found;
}

function parseQwenParameterValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return '';
  }
  const first = trimmed[0];
  if (first !== '{' && first !== '[' && first !== '"' && first !== '-' && !/[0-9tfn]/.test(first)) {
    return raw;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

function extractMistralBracketToolCalls(text: string, availableTools: readonly string[]): Array<{ tool: string; args: Record<string, unknown> }> {
  const found: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const re = new RegExp(MISTRAL_BRACKET_RE.source, 'g');
  for (const match of text.matchAll(re)) {
    const toolName = match[1];
    if (!availableTools.includes(toolName)) {
      continue;
    }
    const start = match.index! + match[0].length;
    if (start >= text.length || text[start] !== '{') {
      continue;
    }
    const end = findMatchingBrace(text, start);
    if (end === -1) {
      continue;
    }
    try {
      const args = JSON.parse(text.slice(start, end + 1));
      if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
        found.push({ tool: toolName, args: args as Record<string, unknown> });
      }
    } catch {
      // ignore malformed mistral payloads
      continue;
    }
  }
  return found;
}
