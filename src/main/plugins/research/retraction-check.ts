/**
 * 撤稿核查。
 *
 * ## 它回答的问题与 `citation-integrity.ts` 不同
 *
 * 那份文件只回答「`\cite` 的键在不在当前参考文献里」。它答不了另一半：**这篇文献还在不在**。
 * 一条被撤稿的论文完全可以有正确的元数据、正确的键、正确的页码——它只是不该再被当作证据。
 * 对科研助手来说，这是「没有证据的主张不能导出」这条口径的直接延伸。
 *
 * ## 为什么只用 OpenAlex，不用 Crossref + retraction watch 两路
 *
 * OpenAlex 的 work 记录带 `is_retracted`，它已经聚合了 Crossref 的撤稿/更新关系与 Retraction
 * Watch 的数据；再自己拼两路只会得到三份互相矛盾的结论。**结论只有三档**：
 *
 * - `retracted`：OpenAlex 明确标记撤稿；
 * - `clear`：查到了这条 work，且没有撤稿标记。这是「在本次核查时点没有撤稿记录」，不是
 *   「永远安全」——所以结果里带 `checkedAt`；
 * - `unknown`：没有 DOI、查不到、或网络/响应失败。**不把失败当安全**：`unknown` 必须显示成
 *   「没查到」，不能显示成「正常」。
 *
 * ## 边界
 *
 * - **不进离线工具链**：编译与导出必须保持 `networkAccess: 'none'`。这是主进程的联网动作，
 *   与 `library.importDoi` 同一条路（同一个 `fetchImpl`、同样的超时）。
 * - **不写库、不改条目**：撤稿是新增证据，不是自动删除。结果返回给调用方（助手工具/界面），
 *   由人决定要不要换文献。无数据库迁移、无后台轮询。
 * - 纯函数只管 URL 与响应解析，网络在 `library-service.ts` 里：单测不需要网络。
 */

const OPENALEX_BASE = 'https://api.openalex.org/works';
/** 单次核查上限：这是给人看的确认动作，不是批量抓取。 */
export const retractionCheckLimit = 50;

export type RetractionStatus = 'retracted' | 'clear' | 'unknown';

export type RetractionResult = {
  id: string;
  citationKey: string;
  doi: string | null;
  status: RetractionStatus;
  /** 结论来自哪里、什么时候：`checkedAt` 是结论的一部分，不是装饰。 */
  checkedSource: 'openalex';
  detail: string | null;
  /** 核查时点。它是结论的一部分：`clear` 只代表「那一刻没有撤稿记录」。 */
  checkedAt: string;
};

/** DOI → OpenAlex work URL。用 `doi:` 前缀让 OpenAlex 自己解析标识符，不做本地 URL 拼接猜测。 */
export function openAlexWorkUrl(doi: string): string {
  return `${OPENALEX_BASE}/https://doi.org/${encodeURIComponent(doi)}`;
}

/**
 * 解析一份 OpenAlex work 记录。
 *
 * 只读两个字段，且都按「不可信输入」处理：`is_retracted` 必须是布尔，否则降级为 `unknown`
 * （上游换契约时宁可说不知道，也不能把 `undefined` 读成 false 而报「正常」）。
 */
export function readOpenAlexRetraction(payload: unknown): { status: RetractionStatus; detail: string | null } {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return { status: 'unknown', detail: 'openalex_payload_invalid' };
  const record = payload as Record<string, unknown>;
  if (typeof record.is_retracted !== 'boolean') return { status: 'unknown', detail: 'openalex_retraction_flag_missing' };
  if (record.is_retracted) {
    const title = typeof record.title === 'string' && record.title.trim().length > 0 ? record.title.trim() : null;
    return { status: 'retracted', detail: title === null ? 'openalex_is_retracted' : `openalex_is_retracted:${title}` };
  }
  return { status: 'clear', detail: null };
}

export function unknownRetraction(input: { id: string; citationKey: string; doi: string | null; detail: string; checkedAt: string }): RetractionResult {
  return { ...input, status: 'unknown', checkedSource: 'openalex' };
}
