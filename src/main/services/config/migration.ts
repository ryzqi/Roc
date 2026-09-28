import type { RocSettingsDocument } from '../../../shared/types';

export function isCurrentSettingsDocument(value: unknown): value is RocSettingsDocument {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as { schemaVersion?: unknown };
  return record.schemaVersion === 4;
}
