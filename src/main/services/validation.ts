import { RocDomainError } from './errors';

export function requireText(value: string, code: string, message: string, userAction: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new RocDomainError({
      code,
      message,
      category: 'validation',
      retryable: false,
      userAction
    });
  }
  return trimmed;
}
