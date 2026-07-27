import * as recordUtils from './record-utils';
import { redact } from './redact';

export function redactUnknown(value: unknown): unknown {
  if (typeof value === 'string') {
    return redact(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item));
  }
  if (recordUtils.isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactUnknown(entry)])
    );
  }
  return value;
}
