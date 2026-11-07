# S08 本地候选版、升级与冷恢复手册

日期：2026-11-07。适用于本轮 Roc 0.1.0 / macOS arm64 候选构建。
这是本地操作材料，未执行真实用户数据升级、上传、notarization 或正式发布。
具体检查结果见 [S08 执行报告](s08-execution-report.md)。

## 变更与版本

- 导出增加 `provenance/validation.json`，validation v1、export manifest v4。
  清单绑定人工审核文件、语义报告有效性、claim/source/artifact/hash、实验材料、
  不可变执行 Skill pin 与模型来源。批准、交付前共同复核人工与语义快照。
- 实验文件可用性、实际重放和科学复现分别记录；默认 `not_run` / `not_verified`。
  metadata-only 资料不是随包全文，本地导出不执行外部发布。
- 老 v3 ZIP 原始字节仍保留，但不能作为当前已验证导出继续交付；从当前有效来源
  重新生成并人工审核。不得补造历史 Skill、模型版本或审批。
- 科研核验结论支持 supports、qualifies、contradicts、unrelated、insufficient、
  unable_to_verify 六种状态；unrelated 与 unable_to_verify 也保留原因和覆盖范围，不覆盖人工决定。
  共享输出合同升级后旧 Skill pin 不能静默续跑；已有建议按 skill_changed 标记过期，
  使用当前材料重新核验并审核导出。科学判据 rules v1 未改变。
- S02～S07 提供统一执行身份/事件、Manifest、人工审稿闭环、冻结查询、DAG 与
  执行前权限复核；它们没有替代人工科学审核。

| 层 | 当前合同 / 构建版本 |
| --- | --- |
| 应用 / Electron | 0.1.0 / 45.0.0；Node 26.13.0、pnpm 12.5.1 |
| 数据库 | core1、agent21、memory2、task1、workspace1、diagnostics1、research64 |
| 执行与任务 | run snapshot v10；Task v3；research execution v3；event envelope v1；DAG v1 |
| 检索 / Skill | search plan v1；Manifest v1；11 个内置研究 Skill 均 1.3.0；output schema v4 |
| 导出 | manifest v4；validation v1；scientific-review snapshot v5；公开投影保留原合同 |
| 模型 | 按每次真实 execution context 保存 provider/model/version；没有统一模型版本承诺 |
| 科学评测 | 以 evaluation protocol lock / dataset revision 为准；独立数据与 live lock 尚缺 |

可重建版本需同时保存 Git commit、lockfile、最终源码 hash、工具链清单与包内容 hash。
版本号 0.1.0 本身不能区分这些开发构建。最终机器记录在 S08 的 `final-verification.json`。

## 停机与离线升级

1. 明确用户授权的数据根、workspace、停机窗口、备份位置与候选应用。
   本轮只演练隔离目录，不能将其授权解释为可改写真实用户数据。
2. 在旧应用停止新 dispatch，取消/暂停任务并等到真实 cleanup 完成，关闭所有相关
   Electron/worker/CLI 数据库连接。记录未决预算与 effect。`unknown` 不能写成零或成功。
3. 保存匹配的旧应用及源码 SHA；完整备份 `ROC_DATA_ROOT`（配置、安全存储引用、
   索引及全部数据库），并按实际需要保存工作区副本或 sentinel/hash 清单。
   不能单独复制正在写入的 DB 文件而遗漏 WAL。系统钥匙串仍由 macOS 管理，
   不导出明文凭证，不自动修改其访问控制。
4. 检查七个数据库的 schema/checksum、integrity、FK、跨库引用和停机状态。
   转换器只接受 agent/research 的 19/60、20/61、20/62、20/63 四组起点，其他组合拒绝。
5. 对已停机目录执行转换，目标目录必须不存在且在源目录外：

```sh
node scripts/migrate-databases.mjs \
  --source /stopped-app-root/plugin-data \
  --destination /new-empty-migration-output \
  --stopped
```

这些路径是操作示意，执行前替换成已确认的隔离/用户授权目标。源路径必须是
`plugin-data`，不能把外层应用目录直接传给转换器。命令从仓库根运行。
`--stopped` 是调用方的停机声明，不是杀进程命令；维护租约与实际状态校验仍会执行。

6. 核对输出 `backup/`、`current/`、`migration-report.json`。只有报告通过才能继续。
   原事件/事实/回执和预算保持可审计；不可重建的执行进入只读历史，明确禁止续跑。
   转换可追加 `historical_execution_not_resumable` 状态事件，不伪造原始历史事件。
7. 在新的完整应用数据副本中保留外层配置与索引，使用转换后的 `current/` 作为
   其 `plugin-data/`。先运行匹配候选应用，检查项目、Task、事件、evidence、回执、预算
   和工作区 hash。旧审批不授权新执行；需要继续时用当前输入重新确认。
8. 保留旧备份至确认升级与恢复方案均可用。未决副作用、schema/hash/ref 不一致或
   cleanup 未结束时停止切换，保留报告，不能启用兼容 reader 或忽略损坏。

## 匹配旧版本冷恢复

先停新版所有写入并保存新版目录与诊断，核对升级后产生的文件/外部 effect。
数据库回退不会撤销已发送请求、远端发布或工作区修改，必须单独对账。
不要把新版库交给旧程序，也不要把旧备份覆盖仍在运行的数据目录。

从完整旧备份创建独立恢复目录，包含转换器 `backup/` 对应数据库与原外层配置/索引，
用保存的旧应用启动。对比 Task、原始 event envelope、evidence、非空 effect receipts、
预算行及工作区 sentinel；确认后才按授权切换数据根。本轮真实演练从 S05 `9d16212d`
的 agent20/research63 升到 21/64，并恢复到匹配旧版，报告中的所有对应校验通过。
旧研究阶段的故障终态也被保留；迁移成功不表示该科研任务成功。

## 材料许可、隐私与费用

11 个研究 Skill 的 `LICENSE.md` 为项目作者保留权利、限 Roc 内使用，不能宣称它们
采用开源许可证。第三方内容不能套用这份声明。实际版本与许可证 hash 在 Manifest 中。
Tectonic 0.17.0 和 Vale 3.24.0 为 MIT，Typst 0.15.0 为 Apache，CSL 为 CC BY-SA 3.0；
TeX/字体是多许可证集合，必须保留各自声明。以
[工具链许可清单](../resources/research-runtime/licenses/README.md) 与随包原文为准。
本轮包不带 Python、uv 或模型权重；按需模型的 revision/hash/license 由独立锁控制。

论文、数据、附件的分发权限逐资源审核；不能因可读取或存在 URL 就认定可再分发。
未许可原文保持 metadata-only，记录获取依赖；脱敏公开投影不等于拥有版权许可。
导出前检查批准的标题、作者、说明和附件，备份/诊断只存授权的本地目录。

执行前配置 provider/model 与项目预算；实际费用使用记录的价格版本和 receipt。
未知 usage/cost 保持未知。科学 A/B 必须先固定硬费用上限、请求次数与凭证隔离。
本轮只使用本地合成 provider，不产生可报告的真实模型质量或价格比较。

从助手停止运行，或在管理任务抽屉暂停/取消根 Task，并等待 cleanup 终态。
Worker 崩溃后先看诊断、lease/fence 与 effect 对账；不能将重试视为撤销或安全重做。
无法停止时保留现场并阻止迁移，不修改 DB 将任务伪装为 completed。

## 发布边界

候选应用采用 ad-hoc 签名，未 notarize、未上传、未正式发布。
macOS 对该构建的钥匙串访问可能要求用户在系统弹窗中授权；禁止用明文落盘或
修改系统安全策略绕过这一边界。发布需要具体版本/目标/材料授权及适用验收完成。
独立语料仍为 0/200，双人审查、live A/B、真实账号互操作和原生 OS IME 验收尚未完成。
S09 实验树/远程后端需独立立项，本轮没有启动。
