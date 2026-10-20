import type { z } from 'zod';

import {
  builtinSkillSourceStatusSchema,
  builtinSkillsAutoUpdateRequestSchema,
  builtinSkillsCheckRequestSchema,
  builtinSkillsCheckResultSchema,
  builtinSkillsStatusSchema
} from '../schemas/builtin-skills';
import {
  skillFilePreviewRequestSchema,
  skillFilePreviewResultSchema,
  skillFileTreeRequestSchema,
  skillFileTreeResultSchema,
  skillImportRequestSchema,
  skillSnapshotSchema
} from '../schemas/ipc-mcp-skills';

export type SkillSnapshot = z.infer<typeof skillSnapshotSchema>;
export type SkillFileTreeRequest = z.infer<typeof skillFileTreeRequestSchema>;
export type SkillFileTreeResult = z.infer<typeof skillFileTreeResultSchema>;
export type SkillFileEntry = SkillFileTreeResult['entries'][number];
export type SkillFilePreviewRequest = z.infer<typeof skillFilePreviewRequestSchema>;
export type SkillFilePreviewResult = z.infer<typeof skillFilePreviewResultSchema>;
export type SkillImportRequest = z.infer<typeof skillImportRequestSchema>;

export type BuiltinSkillSourceStatus = z.infer<typeof builtinSkillSourceStatusSchema>;
export type BuiltinSkillsStatus = z.infer<typeof builtinSkillsStatusSchema>;
export type BuiltinSkillsCheckRequest = z.infer<typeof builtinSkillsCheckRequestSchema>;
export type BuiltinSkillsCheckResult = z.infer<typeof builtinSkillsCheckResultSchema>;
export type BuiltinSkillsAutoUpdateRequest = z.infer<typeof builtinSkillsAutoUpdateRequestSchema>;
