# S05 冻结检索与排序回执验收

日期：2026-11-07。开始 SHA：`4381104`。
范围状态：`Verified passing（S05 工程 L0/L1）`。

## 实现

- RH-10.1～10.3：计划 schemaVersion/version、稳定 query ID、视角理由与预期证据，
  最多 3 查询、60 候选，显式含重试请求预算，付费 provider cap 为 0。
  人工批准绑定完整计划；worker 只能引用获批 ID，工具重建不重置持久化占用。
- RH-11.1：沿用 DOI/arXiv/PMID 身份、别名、版本和冲突拥有者；标题不建立身份。
- RH-11.2：保留原始 provider rank/RRF 回执；本地 chunk 搜索增加输入 hash、
  RRF 版本、channel rank/分数理由、chunk hash、locator、索引来源版本与输出位置。
  损坏来源拒绝返回；索引版本与原文件实时状态分别表述。
- RH-11.4：沿用 transport ledger、限流/缓存/取消及逐页授权复核，
  coverage 区分 no_results/not_searched，partial 不伪装完整覆盖。
- RH-10/11.6：移除 queryIndex 授权入口，切换审核 UI 和消费者；11 阶段 output
  schema v3 与 manifest/catalog 一起更新。research63 使用离线切换门，旧计划保留
  原文审计和历史文本、撤销批准，相关项目需从 discovery 重新生成计划。

RH-11.3 新语义排序算法和 RH-11.5 的 50 个独立问题公平采纳未完成，
缺少 S01 独立数据与人工判断；生产继续使用既有 RRF，不宣称检索质量收益。

## 验证

cwd 均为 `/Users/Apple_501/Desktop/Roc/Roc`，开始 SHA `4381104`，
Node v26.13.0、pnpm 12.5.1。提交前以源码 hash 固定验证对象，提交 SHA 在下一阶段登记。

[全量采集](../.artifacts/research-harness/S05/2026-11-07T02-24-12.563Z/verification.json)
记录精确命令、起止时间、退出码、源码和日志 hash。unit 1555/1555、renderer 串行
450/450、Harness 94/94、review workflow 1/1、typecheck、skills、IPC、local retrieval、
network benchmark、build、renderer chunks、Electron smoke 13/13 均通过。
采集期间源码未变。smoke 使用 dist-main-fallback、full=false；完整包验收留 S08。
本地检索仅 3 个工程 fixture；学术检索 CLI 由 unit 实际执行，未运行独立科学语料。

最终复核修正两处迁移遗漏：保留 archived 项目；转换 schema13 的旧查询结果和
queryIndex strategy 到 schema14 历史标记。原始 JSON 保留审计，候选、排名、来源
保持不变；stage pool 重新计算 hash，无策略的 review/monitor pool 保持原 bytes/hash。
生产 reader 只读当前合同，旧审批不可复用，损坏 pool 拒绝转换，源库保持不变。

归档问题先由隔离测试复现（`archive-before-v2.log`），修正后 5/5；
回执/检索关联专项 109/109（`receipts-final.log`）。
[最终补验](../.artifacts/research-harness/S05/2026-11-07T03-07-01.178Z/verification.json)
覆盖迁移冷启动、历史标注包和拒绝路径 14/14、IPC 与 build（含 typecheck/skills），均 exit 0。
补验核对全量日志 hash，记录全量后变化的 7 个文件，采集期间源码未变。
首次补验 typecheck 揭示 evaluator 未区分历史策略，已改为使用历史实际查询并补回归；
失败日志 `typecheck-receipt.log` 保留。

浅色计划详情与深色 800px 长查询截图已目视核对，焦点、内部滚动、底部审批按钮和
预算说明可见，无横向溢出。截图和上述专项日志位于 `.artifacts/research-harness/S05/`。

## 切换、限制和下一步

删除 queryIndex 执行授权，生产新计划不接受旧 serializer。11 阶段 output schema v3、
manifest/catalog 与 UI 一起切换；迁移台账 M09 与删除台账 D13 登记本阶段边界。
真实用户库未转换，未触及外部账号或发布。

RH-11.3/11.5 独立算法采纳与科学比较依赖 S01 独立材料，仍为未运行；
本阶段只通过冻结查询、排序回执、迁移和现有 RRF 的工程合同。
提交后进入 S06，在同一 Task/Effect/预算拥有者上实现节点依赖和持久化 lease。
