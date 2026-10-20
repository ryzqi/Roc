/**
 * 正文进入导出前的结构性检查。
 *
 * ## 这里只查一条规则，以及为什么
 *
 * 这一版最初打算补「`hypothesis` 段落会被编译进 PDF」这条缺口，理由是
 * `evidence.assertPublishable()` 第一行就对非 figure 产物 return。那个观察是对的，
 * **结论是错的**：同一个不变量由另一条更早、更强的路径管着——
 *
 * ```
 * manuscript-repository.ts:118  resolveManuscriptClaims()
 *   └─ 对 sections 里每一个 claim 调 evidence.assertSupported(claim)
 *        ├─ :39   saveManuscript()          写正文时就拒绝非 supported 的主张
 *        └─ :109  requireCurrentManuscript() 每次读正文（含导出）时再验一次
 * ```
 *
 * 所以「未经支持的主张进入正文」今天不可达：它既写不进去，读出来也会被拒。证据是否存在由
 * `getEvidence()` 保证。**把这些再查一遍不会多拦住任何东西**，只会让后来者以为它们原本没被管。
 * 这是本文件唯一保留一条规则的原因，也是这段说明存在的原因：下一个人不该重新推一遍。
 *
 * ## 真正没有被管的那条
 *
 * `assertSupported()` 只看状态与证据，**不看 `subjectType`**。而：
 *
 * - `renderSections()`（`latex-source.ts`）渲染 `section.claimIds` 里的每一个 claim，不按
 *   `subjectType` 过滤；
 * - `renderExportBody()` 又按 `subjectType === 'figure'` 把同一批 claim 挑出来当图注。
 *
 * 于是「一条 figure 主张被放进正文小节」会同时成为：正文里的一句话（下面没有对应的图）与
 * 图注里的一句话（同一句出现两次）。写正文的阶段角色确实可能这么做——它的输出 schema 里
 * `claims[].subjectType` 可以取 `figure`，而 `sections[].claimIndexes` 能指向任意一条 claim。
 *
 * 这就是本模块现在唯一的规则。
 *
 * ## 为什么是纯函数
 *
 * 判定只依赖「小节 → claim」这份已经取到的结构，不读库、不跑进程。因此它可以在
 * `collect()` 的副作用之前被调用，也能直接进 `tests/unit`
 *（`toolchain.ts` 那类带 `?raw` 与原生依赖的模块在 `platform:'neutral'` 下测不了）。
 */

export type ManuscriptIntegrityViolation = {
  /** 领域码，直接进错误信息；沿用 `research_claim_unverified:<id>` 那套 `<code>:<定位>` 约定。 */
  code: string;
  severity: 'block' | 'warn';
  /** 定位：claim id。用户要能凭它找到那段话。 */
  subject: string;
  sectionIndex: number | null;
  detail: string;
};

type IntegrityClaim = {
  id: string;
  subjectType: 'claim' | 'paragraph' | 'figure';
};

export function checkManuscriptBody(input: {
  sections: readonly { title: string; claimIds: readonly string[] }[];
  claims: readonly IntegrityClaim[];
}): ManuscriptIntegrityViolation[] {
  const byId = new Map(input.claims.map((claim) => [claim.id, claim]));
  const violations: ManuscriptIntegrityViolation[] = [];
  for (const [sectionIndex, section] of input.sections.entries()) {
    for (const claimId of section.claimIds) {
      const claim = byId.get(claimId);
      // 取不到 claim 说明调用方给的集合与 sections 不同源。这里跳过而不是报错：本函数的输入
      // 已经过 `resolveManuscriptClaims()`，那条路径上悬空 id 会先抛 `research_claim_artifact_mismatch`；
      // 在这里再造一个码只会让同一个问题有两个名字。
      if (claim === undefined) continue;
      if (claim.subjectType === 'figure') {
        violations.push({ code: 'research_export_figure_claim_in_body', severity: 'block', subject: claim.id,
          sectionIndex, detail: `小节「${section.title}」里放了一条图稿主张：图稿主张只能作为图注。` });
      }
    }
  }
  return violations;
}

/**
 * 第一条阻断项，用来构造 `Error`。
 *
 * 只取第一条而不是汇总：抛出点的错误码就是用户看到的信号（这个域没有码到文案的映射层），
 * 把多条拼成一个字符串会让它既不可读也不可匹配。
 */
export function firstBlockingViolation(violations: readonly ManuscriptIntegrityViolation[]): ManuscriptIntegrityViolation | null {
  return violations.find((violation) => violation.severity === 'block') ?? null;
}
