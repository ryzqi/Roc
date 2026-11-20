/**
 * Decode JSON that this repository wrote itself (cache markers, receipts, worker output).
 *
 * A bare `JSON.parse` turns a corrupt artifact into a `SyntaxError` with no identity, so the CLI
 * reports a crash instead of which file is broken. These helpers either fail with the caller's code,
 * or treat "corrupt" as "absent" where that is the intended recovery (an unreadable marker is simply
 * not a valid marker, and the caller re-creates it).
 */

export function decodeJson<T>(text: string, errorCode: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(errorCode);
  }
}

export function decodeJsonOrNull<T>(text: string): T | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as T) : null;
  } catch {
    return null;
  }
}
