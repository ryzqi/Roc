import { z } from 'zod';

export const approvalModeSchema = z.enum(['fully_automatic', 'default']);

export const mcpServerConfigSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    enabled: z.boolean(),
    transport: z.enum(['stdio', 'http', 'sse']),
    preset: z.boolean(),
    riskLevel: z.enum(['low', 'medium', 'high']),
    url: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
    allowedTools: z.array(z.string().min(1))
  })
  .strict();

export const mcpServerSnapshotSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    enabled: z.boolean(),
    transport: z.enum(['stdio', 'http', 'sse']),
    status: z.enum(['not_connected', 'ready', 'error']),
    tools: z.number(),
    preset: z.boolean().optional(),
    riskLevel: z.enum(['low', 'medium', 'high']).optional(),
    url: z.string().optional(),
    command: z.string().optional(),
    allowedTools: z.array(z.string()).optional(),
    lastError: z.string().nullable().optional()
  })
  .strict();

export const mcpServerTestResultSchema = z
  .object({
    serverId: z.string(),
    status: z.enum(['ready', 'invalid']),
    checked: z.array(z.string()),
    error: z.string().nullable()
  })
  .strict();

export const mcpServersConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    approvalMode: approvalModeSchema,
    servers: z.array(mcpServerConfigSchema)
  })
  .strict();

export const mcpServerEnabledRequestSchema = z
  .object({ id: z.string(), enabled: z.boolean() })
  .strict();

export const mcpApprovalModeRequestSchema = z
  .object({ approvalMode: approvalModeSchema })
  .strict();

export const skillSnapshotSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    enabled: z.boolean(),
    path: z.string(),
    description: z.string(),
    status: z.enum(['ready', 'invalid']),
    lastError: z.string().nullable().optional()
  })
  .strict();

export const skillImportRequestSchema = z
  .object({ sourcePath: z.string(), id: z.string().optional() })
  .strict();

export const skillEnabledRequestSchema = z
  .object({ id: z.string(), enabled: z.boolean() })
  .strict();

const skillFileEntrySchema = z
  .object({
    name: z.string(),
    relativePath: z.string(),
    type: z.enum(['file', 'directory']),
    size: z.number(),
    updatedAt: z.string()
  })
  .strict();

export const skillFileTreeRequestSchema = z
  .object({ id: z.string(), relativePath: z.string() })
  .strict();

export const skillFileTreeResultSchema = z
  .object({
    id: z.string(),
    rootPath: z.string(),
    relativePath: z.string(),
    entries: z.array(skillFileEntrySchema),
    truncated: z.boolean()
  })
  .strict();

export const skillFilePreviewRequestSchema = z
  .object({
    id: z.string(),
    relativePath: z.string(),
    maxBytes: z.number().int().optional()
  })
  .strict();

export const skillFilePreviewResultSchema = z
  .object({
    id: z.string(),
    relativePath: z.string(),
    kind: z.enum(['text', 'image', 'binary']),
    content: z.string(),
    truncated: z.boolean(),
    sizeBytes: z.number(),
    mediaType: z.string().optional()
  })
  .strict();
