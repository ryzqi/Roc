export type JsonObject = Record<string, unknown>;

const SCHEMA_COMPOSITION_KEYS = ['anyOf', 'oneOf', 'allOf'] as const;

export function sanitizeProviderToolJsonSchema(schema: JsonObject): JsonObject {
  const resolved = resolveSchemaComposition(schema);
  const sanitized: JsonObject = {};
  const type = sanitizeSchemaType(resolved.type) ?? sanitizeSchemaTypeFromCompositions(resolved);
  if (type !== undefined) {
    sanitized.type = type;
  }

  copyStringField(resolved, sanitized, 'description');
  copyStringField(resolved, sanitized, 'format');
  copyStringField(resolved, sanitized, 'pattern');
  copyNumericField(resolved, sanitized, 'minLength');
  copyNumericField(resolved, sanitized, 'maxLength');
  copyNumericField(resolved, sanitized, 'minimum');
  copyNumericField(resolved, sanitized, 'maximum');
  copyNumericField(resolved, sanitized, 'exclusiveMinimum');
  copyNumericField(resolved, sanitized, 'exclusiveMaximum');
  copyNumericField(resolved, sanitized, 'minItems');
  copyNumericField(resolved, sanitized, 'maxItems');

  if (Array.isArray(resolved.enum) && resolved.enum.every((item) => isJsonScalar(item))) {
    sanitized.enum = [...resolved.enum];
  }
  if (isJsonScalar(resolved.const)) {
    sanitized.const = resolved.const;
  }
  if (Array.isArray(resolved.required) && resolved.required.every((item) => typeof item === 'string')) {
    const required = resolved.required.filter((item) => {
      const property = isRecord(resolved.properties) ? resolved.properties[item] : undefined;
      return !isOptionalSchema(property);
    });
    if (required.length > 0) {
      sanitized.required = required;
    }
  }
  if (isRecord(resolved.properties)) {
    sanitized.properties = Object.fromEntries(
      Object.entries(resolved.properties)
        .filter((entry): entry is [string, JsonObject] => isRecord(entry[1]))
        .map(([key, value]) => [key, sanitizeProviderToolJsonSchema(value)])
    );
  }
  if (isRecord(resolved.items)) {
    sanitized.items = sanitizeProviderToolJsonSchema(resolved.items);
  } else if (Array.isArray(resolved.items) && resolved.items.every((item) => isRecord(item))) {
    sanitized.items = resolved.items.map((item) => sanitizeProviderToolJsonSchema(item));
  }
  if (typeof resolved.additionalProperties === 'boolean') {
    sanitized.additionalProperties = resolved.additionalProperties;
  } else if (isRecord(resolved.additionalProperties) && Object.keys(resolved.additionalProperties).length > 0) {
    sanitized.additionalProperties = sanitizeProviderToolJsonSchema(resolved.additionalProperties);
  } else if (resolved.additionalProperties === true || isEmptyObject(resolved.additionalProperties)) {
    sanitized.additionalProperties = false;
  }

  if (sanitized.type === undefined && isRecord(sanitized.properties)) {
    sanitized.type = 'object';
  }
  if (sanitized.type === 'object' && sanitized.additionalProperties === undefined) {
    sanitized.additionalProperties = false;
  }
  if (sanitized.type === 'object' && sanitized.properties === undefined) {
    sanitized.properties = {};
  }
  return sanitized;
}

export function sanitizeOpenAiCompatibleTools<TTool>(tools: readonly TTool[]): TTool[] {
  return tools.map((tool) => sanitizeOpenAiCompatibleTool(tool));
}

export function sanitizeOpenAiCompatibleTool<TTool>(tool: TTool): TTool {
  if (!isRecord(tool) || tool.type !== 'function' || !isRecord(tool.function)) {
    return tool;
  }
  const parameters = tool.function.parameters;
  if (!isRecord(parameters)) {
    return tool;
  }
  return {
    ...tool,
    function: {
      ...tool.function,
      parameters: ensureObjectRootSchema(sanitizeProviderToolJsonSchema(parameters))
    }
  };
}

export function sanitizeAnthropicCompatibleTools<TTool>(tools: readonly TTool[]): TTool[] {
  return tools.map((tool) => sanitizeAnthropicCompatibleTool(tool));
}

export function sanitizeAnthropicCompatibleTool<TTool>(tool: TTool): TTool {
  if (!isRecord(tool) || !isRecord(tool.input_schema)) {
    return tool;
  }
  return {
    ...tool,
    input_schema: ensureObjectRootSchema(sanitizeProviderToolJsonSchema(tool.input_schema))
  };
}

function ensureObjectRootSchema(schema: JsonObject): JsonObject {
  if (schema.type === 'object') {
    return schema;
  }
  return {
    type: 'object',
    properties: {},
    additionalProperties: false
  };
}

function resolveSchemaComposition(schema: JsonObject): JsonObject {
  if (isEmptyNotSchema(schema)) {
    return { type: 'object', additionalProperties: false };
  }

  for (const key of ['anyOf', 'oneOf'] as const) {
    const variants = schema[key];
    if (!Array.isArray(variants)) {
      continue;
    }
    const meaningfulVariants = variants
      .filter((item): item is JsonObject => isRecord(item))
      .filter((item) => !isNullSchema(item) && !isEmptyNotSchema(item))
      .map((item) => resolveSchemaComposition(item));
    if (meaningfulVariants.length === 1) {
      return mergeResolvedSchema(schema, meaningfulVariants[0]!);
    }
    if (meaningfulVariants.length > 1) {
      const firstType = sanitizeSchemaType(meaningfulVariants[0]?.type);
      if (
        firstType !== undefined &&
        meaningfulVariants.every((item) => sanitizeSchemaType(item.type) === firstType)
      ) {
        return mergeResolvedSchema(schema, meaningfulVariants[0]!);
      }
      if (firstType === 'object') {
        return mergeResolvedSchema(schema, {
          type: 'object',
          additionalProperties: false
        });
      }
    }
  }

  const allOf = schema.allOf;
  if (Array.isArray(allOf)) {
    const objectVariant = allOf.find((item) => isRecord(item) && sanitizeSchemaType(item.type) === 'object');
    if (isRecord(objectVariant)) {
      return mergeResolvedSchema(schema, resolveSchemaComposition(objectVariant));
    }
  }
  return schema;
}

function mergeResolvedSchema(parent: JsonObject, resolved: JsonObject): JsonObject {
  const merged: JsonObject = { ...resolved };
  if (typeof parent.description === 'string' && merged.description === undefined) {
    merged.description = parent.description;
  }
  if (parent.default !== undefined && merged.default === undefined) {
    merged.default = parent.default;
  }
  return merged;
}

function sanitizeSchemaType(type: unknown): string | undefined {
  if (typeof type === 'string') {
    return type === 'null' ? undefined : type;
  }
  if (Array.isArray(type)) {
    const firstType = type.find((item) => typeof item === 'string' && item !== 'null');
    return typeof firstType === 'string' ? firstType : undefined;
  }
  return undefined;
}

function sanitizeSchemaTypeFromCompositions(schema: JsonObject): string | undefined {
  for (const key of SCHEMA_COMPOSITION_KEYS) {
    const variants = schema[key];
    if (!Array.isArray(variants)) {
      continue;
    }
    for (const variant of variants) {
      if (!isRecord(variant)) {
        continue;
      }
      const type = sanitizeSchemaType(variant.type) ?? sanitizeSchemaTypeFromCompositions(variant);
      if (type !== undefined) {
        return type;
      }
    }
  }
  return undefined;
}

function isNullSchema(schema: JsonObject): boolean {
  return schema.type === 'null';
}

function isOptionalSchema(schema: unknown): boolean {
  if (!isRecord(schema)) {
    return false;
  }
  if (schema.default !== undefined) {
    return true;
  }
  if (Array.isArray(schema.type) && schema.type.includes('null')) {
    return true;
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.some((item) => isRecord(item) && isNullSchema(item))) {
    return true;
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.some((item) => isRecord(item) && isNullSchema(item))) {
    return true;
  }
  return isAnyTypeSchema(schema);
}

function isEmptyNotSchema(schema: JsonObject): boolean {
  return isRecord(schema.not) && Object.keys(schema.not).length === 0;
}

function isAnyTypeSchema(schema: JsonObject): boolean {
  if (isEmptyNotSchema(schema)) {
    return true;
  }
  if (Array.isArray(schema.anyOf)) {
    const variants = schema.anyOf.filter((item): item is JsonObject => isRecord(item));
    return variants.length > 0 && variants.every((item) => isNullSchema(item) || isAnyTypeSchema(item));
  }
  return false;
}

function copyStringField(source: JsonObject, target: JsonObject, key: string): void {
  const value = source[key];
  if (typeof value === 'string' && value.length > 0) {
    target[key] = value;
  }
}

function copyNumericField(source: JsonObject, target: JsonObject, key: string): void {
  const value = source[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    target[key] = value;
  }
}

function isJsonScalar(value: unknown): boolean {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isEmptyObject(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0;
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
