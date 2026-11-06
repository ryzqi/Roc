# S01 科学验收准备核查

核查日期：2026-11-06。科学状态：`Blocked, not run` / `insufficient`。
接受标准仍为 [AC-15/16](../acceptance.md) 和 [冻结协议](../evaluation-protocol.md)。
本记录是输入与运行准备核查，不是模型质量报告。
机器证据见 [scientific-readiness.json](scientific-readiness.json)。

## 已核查的材料

核查范围为当前仓库（包括隐藏文件，排除依赖、构建和历史工件）及当前文档连接。
仓库只有原 16 项 fixture、待填写的 manifest/审核/仲裁/报告模板；
文档连接工具返回无 connected sessions。未核查用户其他私有目录或现有 provider 凭证。
因此这里只能确认当前可用独立样本 **0/200**，不能推断其他位置不存在材料。

| 验收关口 | 当前证据 | 剩余工作 |
| --- | --- | --- |
| 200 项独立 holdout | fixture audit：八族 independent tasks/clusters 均 0 | 合规来源、预注册 split、冻结包；train/dev 另加 |
| 人工独立双审/仲裁 | 无可用审核记录；模板不计数 | 两位独立审核者，分歧由第三人仲裁；核实身份独立性 |
| 应用答案边界 | 原始 context 前缀故障已复现并修复；真实隔离 worker 回归通过 | 新科学协议绑定修复后真实提交，不沿用旧 bundle |
| 八族真实环境 | worker 为空 MCP/Skill/外部 workspace；prior turns 只是 prompt | 建立 effect/跨会话/故障观察器并逐项验收；JSON 回执不足 |
| 固定两臂、模型与预算 | 无科学 protocol lock 或具体模型/上限 | 同依赖两臂真实 SHA、provider/model/价格和可强制费用上限 |
| 三次配对重复/统计 | 工程实现已验，真实 trial 为 0 | 冻结后运行三次配对重复，保留失败与未知费用 |
| A/B 人类盲审 | 未运行，arm 映射未封存 | 协调人封存映射、独立评分/仲裁，最后解盲 |
| claim/retrieval/context/DAG/attack 专项 | 只有待填写索引 | 建立实际任务/证据关联；不与 200 项重复累加 |

完整科学验收仍依赖真实环境实施。S02/S03/S06/S07 的工作尚未完成，不能因本次
输出故障修复而视为全部八族可验收。S01 总状态保留 `in_progress`。

## 本次运行修复及验证

修复前真实应用输出是 context contract JSON 与模型答案 JSON 的拼接。
缩小复现使用本地 Core 1.2.20 的真实 ChatModelStream：原始 human/system role
位于 message-start，而 assembled output 无条件成为 AIMessage。
应用 adapter 现在在发布文本前读取原始角色；不通过内容裁剪修复 JSON。
真实助手首 token 在 message 完成前仍可输出，usage 和子代理作用域继续保留。

回归同时核查 JSON 虽可解析但事实错误时仍失败，固定 48 个 fixture trial 分母不变，
journal 落盘、预算、隔离、未知费用和清理约束不变。
日志目录：
`.artifacts/research-harness/S01/scientific-readiness-2026-11-06/`。
修复前失败、测试构造错误与修正后的失败证据均保留；最终检查结果和 hash 写入机器记录。
这些无费用本地 transport 检查不计为 live provider 实验。
全量 unit 1486 项、专项回归 34 项、Harness 94 项通过；typecheck、fixture audit
和 build 均 exit 0。精确命令与范围见 [执行记录](../progress.md)。

## 继续科学实验需要的具体输入

1. **受控数据包与审核材料**：manifest 的本地路径及 canonical SHA-256，许可/归属、
   来源簇与具体 split 的预注册记录、隐藏期望、两份独立人工 annotation，
   分歧仲裁。holdout 由独立协调人管理，不暴露给开发或调参流程。
   若尚未收集，先完成来源登记和具体 split 注册，再开始标注，不回填时间或身份。
2. **实验配置及费用授权**：baseline/candidate 两个实际 commit、同一 provider/model、
   temperature/timeout、价格版本、最大请求次数、每请求/每 trial/总费用上限，
   硬上限实现和授权引用；指定 operator 及对账方式。
   访问须通过受控 host，凭证值不进入数据、聊天、日志或仓库。
3. **人工盲审安排**：两位独立科学审核者、仲裁者和盲审协调人，
   稳定匿名 ID、独立性声明、封存/解盲与报告位置。

输入齐备后先用 `node scripts/harness-eval/quality-check.mjs <manifest> <canonical-sha256>`
离线核查；来源/审核/真实环境通过后再固定 worker 与协议锁并 dispatch。
任何缺失、失败或未调用保留原状态，不能替换为 fixture、模型自评或成功形状的空报告。
