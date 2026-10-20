/**
 * 文稿文本的投影：把「段落 → claim」的结构交给 Vale，再把 Vale 的行号映射回来。
 *
 * ## 为什么需要投影，而不是直接把 LaTeX 喂给 Vale
 *
 * 检查结果必须能定位到 `claimId`，否则审稿意见只能落在「第 37 行」，而论文正文的真身不是
 * LaTeX 文件——它是 `sections[].claimIds` 指向的 claim 序列（`latex-source.ts` 从 claims
 * 确定性重算出 LaTeX）。拿 `.tex` 去检查会同时丢掉两件事：行号对不上 claim，以及
 * `\cite{}`、`\section{}` 这类标记会被当成正文词。
 *
 * 所以：**每个小节投影成一个 Markdown 单元**，单元内逐行记录「这一段属于哪个 claim」，
 * Vale 回来时按行号落回 claim。小节标题那一行落在所有 claim 区间之外，因此只会归属到
 * 小节，不会伪装成某个段落的问题。
 *
 * ## 为什么行号必须由本模块自己数
 *
 * 不能把 claim 文本按 `\n` 拼起来再回头用 `indexOf` 找位置：claim 内容里的换行、空行与
 * 重复文本会让这种反查给出错的行号，而错的定位比没有定位更糟——审稿人会去看一行无关的话。
 * 这里只在写入时递增行号，映射关系是构造出来的，不是推断出来的。
 *
 * ## 边界
 *
 * 本模块不读文件、不跑进程、不抛领域错误类型：它是纯函数，直接进 `tests/unit`。
 */

export type ProseSegment = {
  claimId: string;
  /** 1-based，含首尾。落在区间外的行属于小节本身（标题或空行）。 */
  startLine: number;
  endLine: number;
};

export type ProseUnit = {
  /** 相对路径，形如 `sections/000.md`。Vale 的 key 会原样带回这个值。 */
  path: string;
  content: string;
  sectionIndex: number;
  sectionTitle: string;
  segments: readonly ProseSegment[];
};

export type ProseBundle = {
  units: readonly ProseUnit[];
  /** 投影用的 claim 顺序，便于调用方核对「传进来的都投影了」。 */
  claimIds: readonly string[];
};

export type ProseFinding = {
  claimId: string | null;
  sectionIndex: number;
  sectionTitle: string;
  /** 1-based，指单元文件内的行号；claim 区间内的行以 claim 起始为参照。 */
  line: number;
  span: [number, number];
  severity: 'error' | 'warning' | 'suggestion' | 'other';
  style: string;
  rule: string;
  check: string;
  message: string;
  match: string;
};

/** 单个 claim 的正文上限，与 `researchClaimSchema.content` 一致。 */
const maxClaimChars = 20_000;
/** 单元数与段落数的上限，与阶段输出 schema 的 sections/claims 上限一致。 */
const maxSections = 100;
const maxClaims = 500;
/** 一次检查最多回传多少条命中。超出部分计数但不再进报告，避免一次运行刷爆上下文。 */
const maxFindings = 2_000;

function pad(index: number): string {
  return String(index).padStart(3, '0');
}

/**
 * 把小节与 claim 投影成一单元一小节的 Markdown。
 *
 * claim 缺席（`claimIds` 指向一个不在本次 claims 里的 id）直接抛错：那说明调用方拿到的
 * 结构本身是坏的，此时静默跳过会让检查报告「更干净」，正是这套检查要防的事。
 */
export function buildProseBundle(input: {
  sections: readonly { title: string; claimIds: readonly string[] }[];
  claims: readonly { id: string; content: string }[];
}): ProseBundle {
  if (input.sections.length === 0) throw new Error('research_prose_no_sections');
  if (input.sections.length > maxSections) throw new Error('research_prose_section_limit');
  const byId = new Map(input.claims.map((claim) => [claim.id, claim]));
  const units: ProseUnit[] = [];
  const claimIds: string[] = [];
  for (const [sectionIndex, section] of input.sections.entries()) {
    const lines: string[] = [];
    const segments: ProseSegment[] = [];
    const title = section.title.replaceAll('\n', ' ').trim();
    lines.push(`# ${title}`, '');
    for (const claimId of section.claimIds) {
      const claim = byId.get(claimId);
      if (claim === undefined) throw new Error('research_prose_claim_missing');
      if (claim.content.length > maxClaimChars) throw new Error('research_prose_claim_too_long');
      if (claimIds.length >= maxClaims) throw new Error('research_prose_claim_limit');
      claimIds.push(claimId);
      const body = claim.content.split('\n');
      const startLine = lines.length + 1;
      lines.push(...body);
      lines.push('');
      segments.push({ claimId, startLine, endLine: startLine + body.length - 1 });
    }
    units.push({ path: `sections/${pad(sectionIndex)}.md`, content: `${lines.join('\n')}\n`, sectionIndex,
      sectionTitle: title, segments });
  }
  return { units, claimIds };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readLine(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

function readSpan(value: unknown): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) return [0, 0];
  const [start, end] = value;
  if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end)) return [0, 0];
  return [start, end];
}

function readSeverity(value: unknown): ProseFinding['severity'] {
  // Vale 的 Level 只有三档；出现第四种取值说明上游换了契约，此时**不能**并到 warning 里
  // （那会把未知当已知），保留为 other 让消费者自己决定。
  return value === 'error' || value === 'warning' || value === 'suggestion' ? value : 'other';
}

function splitCheck(check: string): { style: string; rule: string } {
  const separator = check.indexOf('.');
  return separator === -1 ? { style: check, rule: check } : { style: check.slice(0, separator), rule: check.slice(separator + 1) };
}

/**
 * 把 Vale 的 JSON 报告映射回 claim。
 *
 * 输入是**未信任的 JSON**（子进程输出），分成两类失败：
 *
 * - **顶层形状不对**（不是对象、alerts 不是数组、单条 alert 不是对象）招 `research_prose_report_invalid`：
 *   那是契约变了，当成「没有命中」是这套检查最坏的失败模式；
 * - **单条 alert 的字段缺失或类型不对**则退化为空值：报告能读比崩了好用，
 *   但**绝不猜测行号**——行号非正数或超出单元范围时 `claimId` 为 `null`，
 *   由调用方按「小节级命中」处理。
 */
export function projectProseAlerts(report: unknown, bundle: ProseBundle): { findings: ProseFinding[]; truncated: boolean; droppedUnits: string[] } {
  if (typeof report !== 'object' || report === null || Array.isArray(report)) throw new Error('research_prose_report_invalid');
  const units = new Map(bundle.units.map((unit) => [unit.path, unit]));
  const findings: ProseFinding[] = [];
  const droppedUnits: string[] = [];
  let truncated = false;
  for (const [path, alerts] of Object.entries(report)) {
    const unit = units.get(path);
    if (unit === undefined) { droppedUnits.push(path); continue; }
    if (!Array.isArray(alerts)) throw new Error('research_prose_report_invalid');
    for (const alert of alerts) {
      if (typeof alert !== 'object' || alert === null) throw new Error('research_prose_report_invalid');
      const fields = alert as Record<string, unknown>;
      const line = readLine(fields.Line);
      const check = readString(fields.Check);
      const segment = line === 0 ? undefined : unit.segments.find((entry) => line >= entry.startLine && line <= entry.endLine);
      if (findings.length >= maxFindings) { truncated = true; continue; }
      findings.push({
        claimId: segment?.claimId ?? null,
        sectionIndex: unit.sectionIndex,
        sectionTitle: unit.sectionTitle,
        line,
        span: readSpan(fields.Span),
        severity: readSeverity(fields.Severity),
        style: splitCheck(check).style,
        rule: splitCheck(check).rule,
        check,
        message: readString(fields.Message),
        match: readString(fields.Match)
      });
    }
  }
  findings.sort((left, right) => left.sectionIndex - right.sectionIndex || left.line - right.line
    || left.span[0] - right.span[0] || (left.check < right.check ? -1 : left.check > right.check ? 1 : 0));
  return { findings, truncated, droppedUnits };
}

export function summarizeProseFindings(findings: readonly ProseFinding[]): {
  error: number; warning: number; suggestion: number; other: number; located: number; unlocated: number;
} {
  const counts = { error: 0, warning: 0, suggestion: 0, other: 0, located: 0, unlocated: 0 };
  for (const finding of findings) {
    counts[finding.severity] += 1;
    if (finding.claimId === null) counts.unlocated += 1;
    else counts.located += 1;
  }
  return counts;
}
