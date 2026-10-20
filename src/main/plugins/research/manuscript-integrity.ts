/**
 * 正文进入导出前的结构性检查。
 *
 * ## 这里只查一条规则，以及为什么
 *
 * 这一版最初打算补「`hypothesis` 段落会被编译进 PDF」，理由是
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
 * 而「supported 但无证据」更早：`evidence-repository.ts` 的 `createClaim()` 就走
 * `validateSupport()`。所以「未经支持的主张进入正文」今天不可达：它既写不进去，读出来也会被拒。
 * 证据是否存在由 `getEvidence()` 保证。**把这些再查一遍不会多拦住任何东西**，只会让后来者以为
 * 它们原本没被管。这是本文件只保留一条规则的原因，也是这段说明存在的原因：下一个人不该重新推一遍。
 *
 * ## 真正没有被管的那条
 *
 * `assertSupported()` 只看状态与证据，**不看 `subjectType`**。而
 * `renderSections()`（`latex-source.ts:7-16`）渲染 `section.claimIds` 里的每一个 claim，
 * 也不看 `subjectType`。于是一条 `subjectType: 'figure'` 的主张可以进正文，并被当作正文散文渲染。
 *
 * 这**不是**「同一句话既是正文又是图注」——图注的筛选多一个条件：
 * `claim.artifactId === figure.artifactId`（`export-sources.ts`），而能进 sections 的 claim 必须
 * 属于正文 artifact（`manuscript-repository.ts:121`）。两者互斥，所以不会重复出现。
 *
 * 它确实是错的，错在**主张的标签与它的落点不符**：
 *
 * - `subjectType` 是「这条主张在讲什么」的声明，`figure` 的含义是「它是一条图稿主张」；
 * - `evidence-repository.ts` 的 `recordClaimProvenance()` 按这个字段把审计边记成
 *   `figure_claim`，于是溯源里会出现一条「图稿主张」指向一个并不存在的图稿；
 * - 审稿人（和人）从溯源读到的归属是假的。
 *
 * 可执行的补救只有一条路：`subjectType` 不可修改（`researchClaimUpdateRequestSchema` 只 pick
 * `content` / `status` / `evidenceIds`），claim 也不能删，所以要**新建一条 `subjectType: 'claim'`
 * 的主张并重新保存正文**。错误文案必须说这条，否则用户拿到的是一句做不到的指示。
 *
 * ## 为什么是纯函数
 *
 * 判定只依赖「小节 → claim」这份已经取到的结构，不读库、不跑进程。因此它可以在
 * `collect()` 的副作用之前被调用，也能直接进 `tests/unit`
 *（`toolchain.ts` 那类带 `?raw` 与原生依赖的模块在 `platform:'neutral'` 下测不了。
 * 另注：`research-export-body-gate.test.mjs` 是用裸 esbuild 打包并配 `loader` 绕过这一限制的，
 * 它证明的是「带 `?raw` 的模块可以用 loader 打包」，与本段说的不是同一件事）。
 */

export type ManuscriptIntegrityViolation = {
  /** 领域码，直接进错误信息；沿用 `research_claim_unverified:<id>` 那套 `<code>:<定位>` 约定。 */
  code: string;
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
      // 已经过 `resolveManuscriptClaims()`，那条路径上悬空 id 会先抛 `research_claim_not_found`，
      // 属于别的 artifact 的 claim 会抛 `research_claim_artifact_mismatch`；
      // 在这里再造一个码只会让同一个问题有两个名字。
      if (claim === undefined) continue;
      if (claim.subjectType === 'figure') {
        violations.push({ code: 'research_export_figure_claim_in_body', subject: claim.id, sectionIndex,
          detail: `小节「${section.title}」里的主张被标成 figure，却在正文里：它的溯源会被记成图稿主张。`
            + '主张类型不能修改，请新建一条类型为 claim 的主张并重新保存正文。' });
      }
    }
  }
  return violations;
}
