import type { z } from 'zod';

import {
  gitBatchFileOperationRequestSchema,
  gitBranchListResultSchema,
  gitBranchMutationResultSchema,
  gitCheckoutBranchRequestSchema,
  gitCommitRequestSchema,
  gitCommitResultSchema,
  gitCreateBranchRequestSchema,
  gitDiffStatResultSchema,
  gitFileDiffResultSchema,
  gitFileOperationRequestSchema,
  gitPushResultSchema,
  gitStatusResultSchema
} from '../schemas/ipc-workspace';

export type GitStatusResult = z.infer<typeof gitStatusResultSchema>;
export type GitStatusChange = GitStatusResult['changes'][number];
export type GitDiffStatResult = z.infer<typeof gitDiffStatResultSchema>;
export type GitFileDiffResult = z.infer<typeof gitFileDiffResultSchema>;
export type GitFileOperationRequest = z.infer<typeof gitFileOperationRequestSchema>;
export type GitBatchFileOperationRequest = z.infer<typeof gitBatchFileOperationRequestSchema>;
export type GitCommitRequest = z.infer<typeof gitCommitRequestSchema>;
export type GitBranchListResult = z.infer<typeof gitBranchListResultSchema>;
export type GitBranchSummary = GitBranchListResult['branches'][number];
export type GitCreateBranchRequest = z.infer<typeof gitCreateBranchRequestSchema>;
export type GitCheckoutBranchRequest = z.infer<typeof gitCheckoutBranchRequestSchema>;
export type GitBranchMutationResult = z.infer<typeof gitBranchMutationResultSchema>;
export type GitCommitResult = z.infer<typeof gitCommitResultSchema>;
export type GitPushResult = z.infer<typeof gitPushResultSchema>;
