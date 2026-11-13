import { z } from 'zod';

/** Supported JSON Schema subset. No defaults, coercion, or output repair. */
export type ResponseJsonSchema =
  | { type: 'string'; enum?: string[]; minLength?: number; maxLength?: number }
  | { type: 'number' | 'integer'; enum?: number[]; minimum?: number; maximum?: number }
  | { type: 'boolean'; enum?: boolean[] }
  | { type: 'null' }
  | { type: 'array'; items: ResponseJsonSchema; uniqueItems?: boolean; minItems?: number; maxItems?: number }
  | { type: 'object'; properties: Record<string, ResponseJsonSchema>; required: string[]; additionalProperties: false };

const size = z.number().int().nonnegative().max(1_000_000);
const fieldName = z.string().min(1).max(200);
const supportedSchema: z.ZodType<ResponseJsonSchema> = z.lazy(() => z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('string'), enum: z.array(z.string().max(2000)).min(1).max(4096).optional(),
    minLength: size.optional(), maxLength: size.optional()
  }),
  z.strictObject({
    type: z.enum(['number', 'integer']), enum: z.array(z.number()).min(1).max(4096).optional(),
    minimum: z.number().optional(), maximum: z.number().optional()
  }).superRefine((schema, context) => {
    if (schema.type === 'integer' && schema.enum?.some(value => !Number.isInteger(value))) {
      context.addIssue({ code: 'custom', path: ['enum'], message: 'Integer enum values must be integers.' });
    }
  }),
  z.strictObject({ type: z.literal('boolean'), enum: z.array(z.boolean()).min(1).max(2).optional() }),
  z.strictObject({ type: z.literal('null') }),
  z.strictObject({
    type: z.literal('array'), items: supportedSchema, uniqueItems: z.boolean().optional(),
    minItems: size.optional(), maxItems: size.optional()
  }),
  z.strictObject({
    type: z.literal('object'), properties: z.record(fieldName, supportedSchema),
    required: z.array(fieldName).max(128), additionalProperties: z.literal(false)
  }).superRefine((schema, context) => {
    if (new Set(schema.required).size !== schema.required.length ||
        schema.required.some(name => !Object.hasOwn(schema.properties, name))) {
      context.addIssue({ code: 'custom', path: ['required'], message: 'Required fields must be unique declared properties.' });
    }
  })
]));

// Check depth before recursive parsing, including locally submitted non-JSON objects.
const boundedSchema = z.unknown().superRefine((value, context) => {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const entry = pending.pop()!;
    if (entry.depth > 12 || ++nodes > 256) {
      context.addIssue({ code: 'custom', message: 'Response schema exceeds the depth or size limit.' });
      return;
    }
    if (typeof entry.value !== 'object' || entry.value === null) continue;
    const schema = entry.value as Record<string, unknown>;
    for (const [minimum, maximum] of [['minLength', 'maxLength'], ['minItems', 'maxItems'], ['minimum', 'maximum']] as const) {
      if (typeof schema[minimum] === 'number' && typeof schema[maximum] === 'number' && schema[minimum] > schema[maximum]) {
        context.addIssue({ code: 'custom', message: `${minimum} must not exceed ${maximum}.` });
        return;
      }
    }
    if (schema.items !== undefined) pending.push({ value: schema.items, depth: entry.depth + 1 });
    if (typeof schema.properties === 'object' && schema.properties !== null) {
      for (const child of Object.values(schema.properties)) pending.push({ value: child, depth: entry.depth + 1 });
    }
  }
  try {
    if ((JSON.stringify(value)?.length ?? 0) > 65536) {
      context.addIssue({ code: 'custom', message: 'Response schema exceeds 65536 characters.' });
    }
  } catch {
    context.addIssue({ code: 'custom', message: 'Response schema must be JSON data.' });
  }
}).pipe(supportedSchema);

export const responseContractSchema = z.strictObject({
  format: z.literal('json'),
  schema: boundedSchema
});
export type ResponseContract = z.infer<typeof responseContractSchema>;

export function createResponseValidator(contract: ResponseContract): (text: string | null) => { passed: boolean; detail: string } {
  const { schema } = responseContractSchema.parse(contract);
  const validator = createSchemaValidator(schema);
  return text => {
    if (text === null || text.trim().length === 0) return { passed: false, detail: 'Final response is missing; return the requested JSON value.' };
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { passed: false, detail: 'Final response is not valid JSON; remove any preface, Markdown fences, or trailing explanation.' };
    }
    const result = validator.safeParse(value);
    return result.success
      ? { passed: true, detail: 'Final response satisfies the requested JSON schema.' }
      : { passed: false, detail: result.error.issues.slice(0, 4)
        .map(issue => `${issue.path.join('.') || '$'}: ${issue.message}`).join('; ').slice(0, 600) };
  };
}

function createSchemaValidator(schema: ResponseJsonSchema): z.ZodType {
  switch (schema.type) {
    case 'string': {
      let validator = z.string();
      if (schema.minLength !== undefined) validator = validator.min(schema.minLength);
      if (schema.maxLength !== undefined) validator = validator.max(schema.maxLength);
      return schema.enum === undefined ? validator : validator.refine(value => schema.enum!.includes(value), 'Use one of the declared string values.');
    }
    case 'number':
    case 'integer': {
      let validator = schema.type === 'integer' ? z.number().int() : z.number();
      if (schema.minimum !== undefined) validator = validator.min(schema.minimum);
      if (schema.maximum !== undefined) validator = validator.max(schema.maximum);
      return schema.enum === undefined ? validator : validator.refine(value => schema.enum!.includes(value), 'Use one of the declared numeric values.');
    }
    case 'boolean':
      return schema.enum === undefined ? z.boolean() : z.boolean().refine(value => schema.enum!.includes(value), 'Use one of the declared boolean values.');
    case 'null':
      return z.null();
    case 'array': {
      let validator = z.array(createSchemaValidator(schema.items));
      if (schema.minItems !== undefined) validator = validator.min(schema.minItems);
      if (schema.maxItems !== undefined) validator = validator.max(schema.maxItems);
      return schema.uniqueItems !== true ? validator : validator.superRefine((items, context) => {
        const seen = new Set<string>();
        for (const [index, item] of items.entries()) {
          const key = JSON.stringify(canonicalValue(item));
          if (seen.has(key)) context.addIssue({ code: 'custom', path: [index], message: 'Array items must be unique.' });
          seen.add(key);
        }
      });
    }
    case 'object': {
      const required = new Set(schema.required);
      return z.strictObject(Object.fromEntries(Object.entries(schema.properties).map(([name, child]) => {
        const validator = createSchemaValidator(child);
        return [name, required.has(name) ? validator : validator.optional()];
      })));
    }
  }
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === 'object' && value !== null) return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, canonicalValue(child)])
  );
  return value;
}
