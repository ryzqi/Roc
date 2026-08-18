import { z } from 'zod';

export const workspaceSchema = z
  .object({
    id: z.string(),
    path: z.string(),
    displayName: z.string(),
    lastOpenedAt: z.string(),
    trustState: z.enum(['trusted', 'limited', 'blocked']),
    defaultShell: z.string().optional()
  })
  .strict();

export const workspaceSelectRequestSchema = z.object({ path: z.string() }).strict();

export const workspaceChangedEventSchema = z
  .object({
    workspacePath: z.string(),
    relativePath: z.string().nullable(),
    eventType: z.enum(['rename', 'change'])
  })
  .strict();

export const fileDialogSelectionSchema = z.object({ filePaths: z.array(z.string()) }).strict();

const fileEntrySchema = z
  .object({
    name: z.string(),
    relativePath: z.string(),
    type: z.enum(['file', 'directory']),
    size: z.number(),
    updatedAt: z.string()
  })
  .strict();

export const fileTreeRequestSchema = z
  .object({ relativePath: z.string(), limit: z.number().int().optional() })
  .strict();

export const fileTreeResultSchema = z
  .object({
    workspacePath: z.string(),
    relativePath: z.string(),
    entries: z.array(fileEntrySchema),
    truncated: z.boolean()
  })
  .strict();

export const fileSearchRequestSchema = z
  .object({ query: z.string(), maxResults: z.number().int().optional() })
  .strict();

export const fileSearchResultSchema = z
  .object({
    query: z.string(),
    matches: z.array(
      z
        .object({
          relativePath: z.string(),
          line: z.number(),
          column: z.number(),
          preview: z.string()
        })
        .strict()
    ),
    truncated: z.boolean()
  })
  .strict();

export const filePreviewRequestSchema = z
  .object({ relativePath: z.string(), maxBytes: z.number().int().optional() })
  .strict();

export const filePreviewResultSchema = z
  .object({
    relativePath: z.string(),
    kind: z.enum(['text', 'image', 'binary']),
    content: z.string(),
    truncated: z.boolean(),
    sizeBytes: z.number(),
    mediaType: z.string().optional()
  })
  .strict();

export const filePdfPreviewRequestSchema = z.object({ relativePath: z.string() }).strict();

export const filePdfPreviewResultSchema = z
  .object({
    relativePath: z.string(),
    resourceUrl: z.string(),
    sizeBytes: z.number(),
    mediaType: z.literal('application/pdf')
  })
  .strict();

export const fileWriteTextRequestSchema = z
  .object({
    relativePath: z.string(),
    content: z.string(),
    source: z.string(),
    threadId: z.string().optional(),
    runId: z.string().optional()
  })
  .strict();

const recoveryPointSchema = z
  .object({
    id: z.string(),
    relativePath: z.string(),
    snapshotPath: z.string(),
    contentSha256: z.string(),
    source: z.string(),
    createdAt: z.string(),
    restored: z.boolean()
  })
  .strict();

export const fileWriteResultSchema = z
  .object({
    relativePath: z.string(),
    recoveryPoint: recoveryPointSchema,
    bytesWritten: z.number()
  })
  .strict();

const gitStatusChangeSchema = z
  .object({
    porcelain: z.string(),
    index: z.string(),
    worktree: z.string(),
    relativePath: z.string(),
    originalPath: z.string().optional()
  })
  .strict();

export const gitStatusResultSchema = z
  .object({
    workspacePath: z.string(),
    isRepository: z.literal(true),
    branch: z.string(),
    porcelain: z.array(z.string()),
    changes: z.array(gitStatusChangeSchema),
    changedFiles: z.number()
  })
  .strict();

export const gitDiffStatResultSchema = z
  .object({ workspacePath: z.string(), stat: z.string() })
  .strict();

export const gitFileOperationRequestSchema = z.object({ relativePath: z.string() }).strict();
export const gitBatchFileOperationRequestSchema = z
  .object({ relativePaths: z.array(z.string()) })
  .strict();

export const gitFileDiffResultSchema = z
  .object({ workspacePath: z.string(), relativePath: z.string(), patch: z.string() })
  .strict();

export const gitCommitRequestSchema = z.object({ message: z.string() }).strict();

const gitBranchSummarySchema = z.object({ name: z.string(), current: z.boolean() }).strict();

export const gitBranchListResultSchema = z
  .object({
    workspacePath: z.string(),
    currentBranch: z.string(),
    branches: z.array(gitBranchSummarySchema)
  })
  .strict();

export const gitCreateBranchRequestSchema = z
  .object({ name: z.string(), checkoutAfterCreate: z.boolean() })
  .strict();

export const gitCheckoutBranchRequestSchema = z.object({ name: z.string() }).strict();

export const gitBranchMutationResultSchema = z
  .object({
    workspacePath: z.string(),
    branchInfo: gitBranchListResultSchema,
    status: gitStatusResultSchema
  })
  .strict();

export const gitCommitResultSchema = z
  .object({
    workspacePath: z.string(),
    commitMessage: z.string(),
    commitSha: z.string(),
    status: gitStatusResultSchema
  })
  .strict();

export const gitPushResultSchema = z
  .object({
    workspacePath: z.string(),
    remoteName: z.string(),
    branch: z.string(),
    status: gitStatusResultSchema,
    output: z.string()
  })
  .strict();

export const terminalSessionCreateRequestSchema = z
  .object({ cwd: z.string().optional(), cols: z.number(), rows: z.number() })
  .strict();

export const terminalSessionSnapshotSchema = z
  .object({
    id: z.string(),
    cwd: z.string(),
    shell: z.string(),
    cols: z.number(),
    rows: z.number(),
    status: z.enum(['starting', 'ready', 'exited', 'error']),
    exitCode: z.number().nullable()
  })
  .strict();

export const terminalSessionInputRequestSchema = z
  .object({ sessionId: z.string(), data: z.string() })
  .strict();

export const terminalSessionResizeRequestSchema = z
  .object({ sessionId: z.string(), cols: z.number(), rows: z.number() })
  .strict();

export const terminalSessionCloseRequestSchema = z.object({ sessionId: z.string() }).strict();

export const terminalSessionOutputEventSchema = z
  .object({ sessionId: z.string(), data: z.string() })
  .strict();

export const terminalSessionExitEventSchema = z
  .object({ sessionId: z.string(), exitCode: z.number().nullable() })
  .strict();

const rtkBypassReasonSchema = z.enum([
  'rtk_binary_missing',
  'user_terminal_raw_output',
  'command_not_supported',
  'virtual_workspace_path',
  'windows_shell_alias',
  'shell_run_not_authorized',
  'background_shell_command_not_pre_authorized'
]);

export const rtkStatusSchema = z
  .object({
    enabledForAgentCommands: z.boolean(),
    binaryPath: z.string(),
    configPath: z.string(),
    teeDir: z.string(),
    resourceState: z.enum(['ready', 'missing']),
    bypassReason: rtkBypassReasonSchema.optional()
  })
  .strict();

export const shellExecutionRequestSchema = z
  .object({
    command: z.string(),
    cwd: z.string().optional(),
    source: z.enum(['agent', 'terminal']),
    threadId: z.string().optional(),
    runId: z.string().optional(),
    signal: z.instanceof(AbortSignal).optional(),
    allowedCommands: z.array(z.string().trim().min(1)).optional()
  })
  .strict();

// AbortSignal and host allowlists are main-process controls, never renderer authority.
export const shellExecutionIpcRequestSchema = shellExecutionRequestSchema.omit({
  signal: true,
  allowedCommands: true
});

export const shellExecutionResultSchema = z
  .object({
    command: z.string(),
    normalizedCommand: z.string(),
    cwd: z.string(),
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number(),
    durationMs: z.number(),
    usedRtk: z.boolean(),
    truncated: z.boolean().optional(),
    rtkVersion: z.string().optional(),
    teePath: z.string().optional(),
    bypassReason: rtkBypassReasonSchema.optional()
  })
  .strict();

export const shellConfirmationRequestSchema = z
  .object({
    title: z.string(),
    message: z.string(),
    confirmLabel: z.string(),
    cancelLabel: z.string()
  })
  .strict();

export const shellConfirmationResultSchema = z
  .object({ confirmed: z.boolean(), response: z.number().int() })
  .strict();
