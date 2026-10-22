import { z } from 'zod';

/**
 * Decode JSON this application wrote into a column or a marker file.
 *
 * A bare `JSON.parse` reports corruption as a `SyntaxError` with no identity, so a broken row looks
 * like a crash in whatever code happened to read it. Decoding through a schema keeps the return type
 * a named domain type and fails with the caller's code, which the run failure mapping can carry.
 *
 * This is for *our own* persisted state, not for untrusted input: untrusted documents go through
 * the schema at their own boundary.
 */

/** Free-form object row (`payload_json`, `envelope_json`): shape is validated by the caller. */
const storedObjectSchema = z.record(z.string(), z.unknown());

export function parseStoredJson<T>(value: string, schema: z.ZodType<T>, errorCode: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(errorCode);
  }
  const decoded = schema.safeParse(parsed);
  if (!decoded.success) {
    throw new Error(errorCode);
  }
  return decoded.data;
}

export function parseStoredJsonObject(value: string, errorCode: string): Record<string, unknown> {
  return parseStoredJson(value, storedObjectSchema, errorCode);
}
