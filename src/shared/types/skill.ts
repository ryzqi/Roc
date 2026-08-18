import type { z } from 'zod';

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
