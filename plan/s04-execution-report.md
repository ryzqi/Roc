# S04 主张核验与独立审稿验收

日期：2026-11-07。开始 SHA：`f62ce04f`。
范围状态：`Verified passing（S04 工程 L0/L1）`；科学盲审未运行。

## 实现与证据

| 合同 | 实现与检查 |
| --- | --- |
| RH-06.1 / AC-06 | 复用 citation coverage/integrity、evidence relations 和现有人工批准门；建议不能改写事实。既有引用、证据、矩阵专项 51 项及完整单测通过 |
| RH-06.2～06.3 | scientific review v1 绑定 claim/version/hash、冻结来源、规则、模型、Skill、task/run；七种主张分别要求条件与原文定位；缺条件拒绝 supports，禁止 confidence/verified 字段 |
| RH-07.1～07.2 / AC-07 | 保留反证、负结果、替代解释、检索覆盖和限定条件；准确 UTF-16 原文定位；来源、主张、正文、人工关系、规则或 Skill 变化令报告失效，原报告保留 |
| RH-09.2 | discovery/ideation/planning 增加问题与排除、竞争假设与失败条件、变量/对照/指标/预算/停止条件；11 阶段 Manifest/catalog hash 同步 |
| RH-16.1 | 子审核者分别实例化，仅可读取冻结稿件、实验、图稿与证据；不读取作者任务上下文或其他审核报告，不能写 claims/sections，也没有批准能力 |
| RH-16.2～16.3 | finding 绑定原报告和意见 ID；人工 addressed 必须绑定修改位置及当前稿件核验；人工拒绝保留理由；旧稿意见沿真实 revision 输入继承，未处理意见阻止人工接受 |
| RH-07.3 | 原工件检查器展示建议、反证、条件、失效与审计；回复矩阵导入不可改写的独立意见并绑定当前核验，键盘保存与失效展示通过 |

核验输入存在既有冻结 context，报告存在既有不可变 stage output；未新建 Evidence Ledger。
删除自由文本审稿作为唯一完成依据、子审核者读取作者输出/开放知识范围，以及无结构化
核验仍能完成独立审稿的分支。有效历史事实、引用核验和人工决定继续由原服务拥有。

## 验证记录

cwd 均为 `/Users/Apple_501/Desktop/Roc/Roc`；Node v26.13.0、pnpm 12.5.1。
验收对象为本阶段待提交差异。精确命令、时间、退出码、源码和日志 hash 见
[首轮报告](../.artifacts/research-harness/S04/2026-11-06T19-16-40.659Z/verification.json)
与[补验报告](../.artifacts/research-harness/S04/renderer-recheck/verification.json)。

- `pnpm typecheck`、`pnpm check:skills`、`pnpm check:ipc`：exit 0。
- `pnpm test:unit`：1552/1552，含新增科学审查 6 项。
- `pnpm harness:eval`：94/94；`pnpm test:review-workflow`：1/1。
- `pnpm build`、`pnpm check:renderer-chunks`：exit 0。
- `node scripts/smoke-electron.mjs`：13/13，dist-main-fallback / full=false。
- `pnpm test:renderer` 首轮 446/450，四个失败位于 lifecycles 和 review-quality-assessment，
  日志记录超时和 browser closed，运行期间跨越长时间暂停。保留失败报告；没有削弱断言。
- `node --test --test-concurrency=1 tests/renderer/lifecycles.test.mjs tests/renderer/review-quality-assessment.test.mjs`：
  串行复测 40/40，所有首轮失败用例通过；并发/长暂停下的稳定性未据此宣称已修复。
- `node --test tests/renderer/response-matrix.test.mjs`：9/9、exit 0。
  仅此测试文件补等 details 动画结束和截图前滚动，生产源码与首轮 hash 一致。
  560px 浅色/深色详情截图人工复核通过，原文、反证、替代解释、条件与键盘焦点可见；
  650px 矩阵通过溢出与阴影审计。完整桌面壳交互仍由 S07 承接。

RH-06/16.4 的独立 claim pilot、300 条最终样本、真实模型盲审与返工统计尚未运行。
工程 fixture 不是科学支持 precision/recall 或语义质量收益证据；不启用更强自动语义门。
没有真实用户数据库迁移、付费模型调用、远端写入或发布。接下来实施 S05。
