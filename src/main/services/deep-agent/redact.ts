export function redact(value: string): string {
  return value
    .replace(/Authorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED]')
    .replace(/Authorization\s*:\s*[^,\n;]+/gi, '[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED]')
    .replace(/nvapi-[A-Za-z0-9._-]+/gi, '[REDACTED]')
    .replace(/sk-[A-Za-z0-9._-]+/gi, '[REDACTED]')
    .replace(/(api[_-]?key|token|password|credential)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[REDACTED]');
}
