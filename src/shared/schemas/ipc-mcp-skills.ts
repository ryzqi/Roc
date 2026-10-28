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

export const mcpServerTransportFieldsSchema = z
  .object({
    transport: mcpServerConfigSchema.shape.transport,
    url: z.string().optional(),
    command: z.string().optional()
  })
  .superRefine((server, context) => {
    if (server.transport === 'stdio' && !server.command?.trim()) {
      context.addIssue({ code: 'custom', path: ['command'], message: '请填写本地服务的启动命令。' });
    }
    if ((server.transport === 'http' || server.transport === 'sse') && !server.url?.trim()) {
      context.addIssue({ code: 'custom', path: ['url'], message: '请填写服务地址。' });
    }
  });

const mcpServerEditorIdSchema = z.string().superRefine((value, context) => {
  if (value.trim().length === 0) {
    context.addIssue({ code: 'custom', message: 'id 不能为空。' });
  } else if (!/^[A-Za-z0-9._-]+$/u.test(value.trim())) {
    context.addIssue({ code: 'custom', message: 'id 只允许字母、数字、点、下划线和短横线。' });
  }
});

export const mcpServerEditorFieldsSchema = z
  .object({
    id: mcpServerEditorIdSchema,
    name: z.string().refine((value) => value.trim().length > 0, { error: '名称不能为空。' }),
    enabled: z.boolean(),
    transport: mcpServerConfigSchema.shape.transport,
    riskLevel: mcpServerConfigSchema.shape.riskLevel,
    url: z.string(),
    command: z.string(),
    allowedTools: z.array(z.string().min(1))
  })
  .superRefine((server, context) => {
    const transportResult = mcpServerTransportFieldsSchema.safeParse(server);
    if (!transportResult.success) {
      for (const issue of transportResult.error.issues) {
        context.addIssue({ code: 'custom', path: issue.path, message: issue.message });
      }
    }

    if (server.transport !== 'stdio' && server.url.trim().length > 0) {
      try {
        const parsed = new URL(server.url.trim());
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          context.addIssue({ code: 'custom', path: ['url'], message: 'URL 必须是 http 或 https。' });
        }
      } catch {
        context.addIssue({ code: 'custom', path: ['url'], message: 'URL 不是合法的绝对地址。' });
      }
    }

    if (new Set(server.allowedTools).size !== server.allowedTools.length) {
      context.addIssue({ code: 'custom', path: ['allowedTools'], message: '允许的工具名有重复项。' });
    }
  });

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
    lastError: z.string().nullable().optional(),
    /** `builtin` rows come from a vendored upstream repository and are refreshed by its sync. */
    origin: z.enum(['builtin', 'user']),
    sourceId: z.string().nullable(),
    upstreamRepo: z.string().nullable(),
    upstreamCommit: z.string().nullable()
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
