import * as recordUtils from './record-utils';

export function redact(value: string): string {
  return value
    .replace(/Authorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED]')
    .replace(/Authorization\s*:\s*[^,\n;]+/gi, '[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED]')
    .replace(/nvapi-[A-Za-z0-9._-]+/gi, '[REDACTED]')
    .replace(/sk-[A-Za-z0-9._-]+/gi, '[REDACTED]')
    .replace(/(api[_-]?key|token|password|credential)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[REDACTED]');
}

/** 标记「JSON 里没有对应表示」的值，对象属性遇到它就整个键丢弃。 */
const noJsonRepresentation = Symbol('noJsonRepresentation');

/**
 * 脱敏并归一化为 JSON 安全值，语义对齐 `JSON.stringify`。
 *
 * 归一化是必需的：LangChain `ToolMessage` / LangGraph `Command` 等实例带着值为
 * `undefined` 的自有可枚举属性（`id`、`status`、`metadata`、`artifact`、`graph`、
 * `resume`），`JSON.stringify` 会静默丢掉它们，但 `z.json()` 会直接拒绝，导致
 * 序列化结果正常而 schema 校验抛错。
 */
export function redactUnknown(value: unknown): unknown {
  const redacted = redactJsonValue(value);
  return redacted === noJsonRepresentation ? undefined : redacted;
}

function redactJsonValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return redact(value);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'boolean' || value === null) {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (!recordUtils.isRecord(value)) {
    // undefined / function / symbol
    return noJsonRepresentation;
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      const entry = redactJsonValue(item);
      return entry === noJsonRepresentation ? null : entry;
    });
  }
  const record: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const redacted = redactJsonValue(entry);
    if (redacted !== noJsonRepresentation) {
      record[key] = redacted;
    }
  }
  return record;
}
