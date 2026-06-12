export type RescueToolCandidate =
  | string
  | {
      name: string;
      acceptsBareArgs?: (args: Record<string, unknown>) => boolean;
    };

export type RescueResult = {
  toolCalls: Array<{ tool: string; args: Record<string, unknown>; id?: string }>;
  strategy:
    | 'json_fence'
    | 'rehearsal'
    | 'qwen_xml'
    | 'mistral_bracket'
    | 'bare_args_json'
    | 'content_block_tool'
    | null;
  reasoningText: string | null;
};

const THINK_TAG_RE = /\[THINK\][\s\S]*?\[\/THINK\]|<think>[\s\S]*?<\/think>/g;
const REHEARSAL_RE = /(\w+)\[ARGS\](\{[\s\S]*?\})/g;
const QWEN_FUNCTION_RE = /<function=([^>\s]+)>([\s\S]*?)<\/function>/g;
const QWEN_PARAMETER_RE = /<parameter=([^>\s]+)>([\s\S]*?)(?:<\/parameter>|(?=<parameter=)|(?=<\/function>)|$)/g;
const MISTRAL_BRACKET_RE = /\[TOOL_CALLS\](\w+)\s*(?=\{)/g;

type NormalizedRescueToolCandidate = {
  name: string;
  acceptsBareArgs?: (args: Record<string, unknown>) => boolean;
};

export function rescueToolCall(text: string, availableTools: readonly RescueToolCandidate[]): RescueResult {
  const toolCandidates = normalizeToolCandidates(availableTools);
  const toolNames = toolCandidates.map((candidate) => candidate.name);
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

  const jsonResults = extractJsonToolCalls(cleaned, toolNames);
  if (jsonResults.length > 0) {
    return { toolCalls: jsonResults, strategy: 'json_fence', reasoningText };
  }

  const rehearsalResults = extractRehearsalToolCalls(cleaned, toolNames);
  if (rehearsalResults.length > 0) {
    return { toolCalls: rehearsalResults, strategy: 'rehearsal', reasoningText };
  }

  const qwenResults = extractQwenXmlToolCalls(cleaned, toolNames);
  if (qwenResults.length > 0) {
    return { toolCalls: qwenResults, strategy: 'qwen_xml', reasoningText };
  }

  const mistralResults = extractMistralBracketToolCalls(cleaned, toolNames);
  if (mistralResults.length > 0) {
    return { toolCalls: mistralResults, strategy: 'mistral_bracket', reasoningText };
  }

  const bareArgsResult = extractBareArgumentToolCall(cleaned, toolCandidates);
  if (bareArgsResult !== null) {
    return { toolCalls: [bareArgsResult], strategy: 'bare_args_json', reasoningText };
  }

  return { toolCalls: [], strategy: null, reasoningText };
}

export function rescueToolCallBlocks(content: unknown, availableTools: readonly RescueToolCandidate[]): RescueResult {
  if (!Array.isArray(content)) {
    return { toolCalls: [], strategy: null, reasoningText: null };
  }

  const toolNames = normalizeToolCandidates(availableTools).map((candidate) => candidate.name);
  const toolCalls: RescueResult['toolCalls'] = [];
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    const toolName = readNonEmptyString(block.name);
    if (toolName === null || !toolNames.includes(toolName)) {
      continue;
    }
    const args = parseToolArgs(block.args ?? block.arguments ?? block.input);
    if (args === null) {
      continue;
    }
    const id = readNonEmptyString(block.id);
    toolCalls.push({
      tool: toolName,
      args,
      ...(id === null ? {} : { id })
    });
  }

  if (toolCalls.length === 0) {
    return { toolCalls: [], strategy: null, reasoningText: null };
  }
  return { toolCalls, strategy: 'content_block_tool', reasoningText: null };
}

function normalizeToolCandidates(availableTools: readonly RescueToolCandidate[]): NormalizedRescueToolCandidate[] {
  return availableTools.map((candidate) => {
    if (typeof candidate === 'string') {
      return { name: candidate };
    }
    return candidate;
  });
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

function parseToolArgs(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

function extractBareArgumentToolCall(
  text: string,
  candidates: readonly NormalizedRescueToolCandidate[]
): { tool: string; args: Record<string, unknown> } | null {
  const stripped = stripJsonFence(text).trim();
  if (stripped.length === 0 || stripped[0] !== '{') {
    return null;
  }
  const end = findMatchingBrace(stripped, 0);
  if (end !== stripped.length - 1) {
    return null;
  }

  let data: unknown;
  try {
    data = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return null;
  }

  const args = data as Record<string, unknown>;
  if (typeof args.tool === 'string' || typeof args.name === 'string' || isRecord(args.args) || isRecord(args.arguments)) {
    return null;
  }

  const matches = candidates.filter((candidate) => candidate.acceptsBareArgs?.(args) === true);
  if (matches.length !== 1) {
    return null;
  }
  return {
    tool: matches[0]!.name,
    args
  };
}

function stripJsonFence(text: string): string {
  return text.replace(/```(?:json)?\s*\n?/g, '').replace(/```/g, '');
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
