import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 派生工件的保留期与磁盘预算（提案 §8「工件发布与恢复」第 4 条要求 P0 冻结这两个数）。
 *
 * 取值依据：P0 实测 15 页论文的 Basic 工件 ~1.3 MB、Standard ~1.7 MB；一台机器上
 * 1 万篇文献约 15 GB。保留期 14 天给「重解析后再回看旧结果」留出余量，8 GiB 预算保证
 * 一个从不清理的项目也不会把磁盘吃满——超预算时按“最久未使用且无人引用”逐个回收。
 */
export const researchArtifactRetentionDays = 14;
export const researchArtifactBudgetBytes = 8 * 1024 * 1024 * 1024;
/** 发布中的 staging 目录最多容忍这么久；超过即视为崩溃残留。 */
const stagingGraceMs = 60 * 60 * 1000;

export type ResearchArtifactGcReport = { scanned: number; removed: number; bytesReclaimed: number; keptBytes: number; overBudget: boolean };

/**
 * 回收 Roc 自有的派生工件目录（`<storage>/artifacts/<id>`）。
 *
 * 只处理三类：**无引用**（没有任何索引文件 payload 指向它）、**无租约**（没有正在发布的
 * staging 目录）、**超过保留期**。原文、整个数据库和用户缓存根都不在清扫范围内——提案 §8
 * 明确禁止扩大清理边界，因为「解析工件没了但原文还在」是可恢复的，反过来则不是。
 */
export async function pruneResearchArtifacts(input: {
  root: string;
  referenced: ReadonlySet<string>;
  now?: () => number;
  retentionMs?: number;
  budgetBytes?: number;
}): Promise<ResearchArtifactGcReport> {
  const now = input.now ?? Date.now;
  const retentionMs = input.retentionMs ?? researchArtifactRetentionDays * 24 * 60 * 60 * 1000;
  const budgetBytes = input.budgetBytes ?? researchArtifactBudgetBytes;
  const report: ResearchArtifactGcReport = { scanned: 0, removed: 0, bytesReclaimed: 0, keptBytes: 0, overBudget: false };
  let entries;
  try { entries = await readdir(input.root, { withFileTypes: true }); }
  catch (error) {
    // 还没有任何工件目录：这是正常的空状态，不是失败。
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return report;
    throw error;
  }
  const candidates: Array<{ id: string; path: string; bytes: number; idleMs: number; referenced: boolean; staging: boolean }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const path = join(input.root, entry.name);
    const info = await lstat(path);
    // 符号链接不是 Roc 自己写的工件，留给调用方自己的安全检查，不在这里跟着链走删东西。
    if (info.isSymbolicLink()) continue;
    report.scanned += 1;
    const staging = entry.name.includes('.staging-');
    candidates.push({ id: entry.name, path, bytes: await directoryBytes(path), idleMs: now() - info.mtimeMs,
      referenced: !staging && input.referenced.has(entry.name), staging });
  }
  const removable = candidates
    .filter((entry) => !entry.referenced && entry.idleMs > (entry.staging ? Math.min(retentionMs, stagingGraceMs) : retentionMs))
    .sort((left, right) => right.idleMs - left.idleMs);
  // 预算按**全部目录**算起（含可回收的），否则会出一个死区：一个本身超预算的工件被算进“可回收”
  // 而没算进 keptBytes，keptBytes 一开始就低于预算，循环第一轮就 break——它永远回收不掉。
  let keptBytes = candidates.reduce((total, entry) => total + entry.bytes, 0);
  for (const entry of removable) {
    // 已回到预算内就不动它：没人引用的旧工件仍然可能是一个用户马上要回看的上一代结果。
    if (keptBytes <= budgetBytes) break;
    await rm(entry.path, { recursive: true, force: true });
    report.removed += 1;
    report.bytesReclaimed += entry.bytes;
    keptBytes -= entry.bytes;
  }
  report.keptBytes = keptBytes;
  report.overBudget = keptBytes > budgetBytes;
  return report;
}

async function directoryBytes(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(child);
    else if (entry.isFile()) total += (await lstat(child)).size;
  }
  return total;
}
