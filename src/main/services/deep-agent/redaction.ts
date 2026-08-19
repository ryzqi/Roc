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

export function redactUnknown(value: unknown): unknown {
  if (typeof value === 'string') {
    return redact(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item));
  }
  if (recordUtils.isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactUnknown(entry)]));
  }
  return value;
}
