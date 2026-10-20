import { z } from 'zod';

const id = z.string().trim().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);

/**
 * 文稿 prose 检查（Vale）的合同。
 *
 * 报告是**可复现的证据**，所以它记下产出它的工具版本与工具链摘要：同一份文稿在两个不同
 * Vale 版本下给出不同结论时，报告本身要能说明这件事发生过。检查不写库、不改文稿，只返回
 * 结果，因此可以随时重跑。
 */
export const researchProseLintRequestSchema = z.object({ projectId: id, artifactId: id }).strict();

export const researchProseFindingSchema = z.object({
  /** 命中落在哪个段落；`null` 表示落在小节本身（标题或空行），不是某个 claim 的问题。 */
  claimId: id.nullable(),
  sectionIndex: z.number().int().nonnegative(),
  sectionTitle: z.string(),
  line: z.number().int().nonnegative(),
  span: z.tuple([z.number(), z.number()]),
  /**
   * Vale 的三档加一个 `other`。留 `other` 是为了**不把未知当已知**：上游若新增一档，
   * 它不会静默计入任何已有档位，消费者也不会因为 schema 拒绝而丢掉整份报告。
   */
  severity: z.enum(['error', 'warning', 'suggestion', 'other']),
  style: z.string(),
  rule: z.string(),
  check: z.string(),
  message: z.string(),
  match: z.string()
}).strict();

export const researchProseLintCountsSchema = z.object({
  error: z.number().int().nonnegative(), warning: z.number().int().nonnegative(),
  suggestion: z.number().int().nonnegative(), other: z.number().int().nonnegative(),
  located: z.number().int().nonnegative(), unlocated: z.number().int().nonnegative()
}).strict();

export const researchProseLintReportSchema = z.object({
  projectId: id, artifactId: id, artifactTitle: z.string(),
  language: z.enum(['zh', 'en']),
  valeVersion: z.string(),
  toolchainHash: digest,
  checkedAt: z.string(),
  counts: researchProseLintCountsSchema,
  /** 命中数超过上限时置位：报告是**被截断的**，不是「只有这些」。 */
  truncated: z.boolean(),
  /** Vale 报了但我们没投影的路径。非空说明投影与检查不一致，值得看，所以留在合同里。 */
  droppedUnits: z.array(z.string()),
  findings: z.array(researchProseFindingSchema)
}).strict();

export type ResearchProseLintReport = z.infer<typeof researchProseLintReportSchema>;
export type ResearchProseFinding = z.infer<typeof researchProseFindingSchema>;
