# 科研工件检查器

## 只读快照合同

`research.artifacts.inspect` / `research.inspectArtifact` 输入只有显式 `projectId`、
`artifactId` 和 nullable `expectedVersion`。工件 ID 必须真实属于所传项目；不接受
任意文件路径、工件标题替代 ID 或旧时间戳版本。主进程在一致的数据库读取事务中
返回实际工件、项目/阶段状态、保存的角色输出、来源运行、任务标识、主张和工件内
原始来源记录。初次读取指定 `expectedVersion:null`。

`version` 是按严格合同序列化这些保存内容后计算的 SHA-256，读取时间不参与。
题名、正文、主张版本、证据定位失效、来源记录或阶段状态变化都会改变快照版本；
同一时间戳内修改也能识别。预期版本不同返回 `status:stale` 及实际新快照，不伪装为
旧版本成功。该版本针对数据库保存的快照，不声称校验任意外部文件的当前字节。

未保存角色输出时 `content:null`；来源运行不存在时 `origin:null`。没有真实任务标识
时没有可用操作；有实际来源任务时仅返回 `return_to_task`。本增量没有批准、退回、
编辑或自动运行能力。原始审核状态和主张状态按保存值返回，不把历史关联升级成新
语义审核，也不把有证据 ID 当成科学支持的证明。

来源记录按工件和项目直接查询，稳定排序；不混入其他工件的来源。主张引用的证据
通过独立只读 `inspectEvidence` 返回原始片段、定位、hash 和实际失效时间。
`referenceStatus:recorded` 仅表示没有保存的失效标记，不表示重新验证原文件或科学
语义；`superseded` 保留原始片段并明确旧定位失效。严格发布消费者的 `getEvidence`
仍拒绝失效证据。缺失、跨项目或原文 hash 损坏分别失败，没有空成功快照。

检查器不读取 `artifact.path`，不请求网络、不运行模型/worker、不写数据库。
结构化实验、图稿和导出文件继续由既有 `inspectProductionInput` /
`readProductionInputFile` 边界校验和读取。助手入口、叠加面板与焦点恢复见下文；
生产类型视图、阅读定位保持和人工闸门的版本绑定仍属后续增量。

## 本增量验证

unit813/813、相关25/25、最终bridge/refusal4/4、Harness94/94、fresh build/typecheck、
native13/13、现有来源/候选renderer23/23、最终启动12/12、IPC/chunks1131153bytes6files
和diff通过。最终4项包括项目缺失的准确not_found分类。之前native13/unit813仍覆盖
数据读取与严格证据消费者；最终错误分类修正不改变保存内容或发布行为。
日志`.artifacts/research-optimization/xui-inspector-*.log`保留；原生工作流每个真实
完成工件的只读快照位于`p0-production/<taskId>/artifact-inspections.json`，校验实际
来源任务/内容运行对应且读取前后数据库total_changes不变。没有真实模型质量、
真实外部客户端或新检查器UI验收的完成声明。

## 助手工件入口与只读叠加面板

人工闸门工具从当前阶段实际工件 ID 的快照生成 `artifactLinks`；每条链接包含真实
项目/工件/预期内容版本及显示元数据。title-only payload 与对应旧展示辅助函数已移除。
链接缺失、重复或非法时明确提示且不能批准，不按题名猜测 ID。发现阶段的原检索计划
显示及 hash 核对继续存在，未被工件链接取代。

必需的打开回调经过 AssistantPanel/Transcript/MessageRow 到 AppShell，纳入 memo 比较。
同壳按需加载 ArtifactInspector，以现有 ModalShell 全高抽屉呈现；没有新常驻导航、
阶段页或第二壳。项目切换立即过滤旧选择并清空。保存的角色 Markdown 另行按需加载，
展示真实主张状态、原始片段、定位失效及原始快照；未保存正文明确为空。

显式刷新沿用上次核对版本。来源变化显示实际新内容和待核对状态，另有显式按当前
版本重读动作；不自动把旧版本视为有效。Escape/关闭恢复实际打开链接的焦点；真实
关联任务动作复用管理抽屉。此增量没有新批准/编辑操作；原批准仍在助手人工闸门。
把当前工件版本绑定到批准/退回，以及刷新后更新整个闸门上下文，是下一增量，
不能把本次只读闭环当成已完成这些写入约束。

最终unit813/813、相关gate/inspector11/11、Harness94/94、fresh build/typecheck/native13/13、
完整串行renderer82/82、启动12/12、IPC/chunks1132666bytes6files与diff通过。
日志`xui-overlay-*.log`及`artifact-inspector-ui/`截图/审计保留。新5项Electron测试
用真实仓库/已注册能力/生成桥接读取真实保存的工件、任务与证据ID；通过Playwright
暴露调用跨到Node测试进程，不宣称这是生产preload传输。已有native13验证实际运行时
持久化，最终生产启动验证壳装配。新UI没有数据库写入、自动批准或模型调用。

明暗1100/1099/800、长原文、reduced-motion、键盘和迟到选择均通过。审计cut0；共享
全高抽屉贴物理上/右/下边，只有这3边阴影完全隐藏且gap0，左侧阴影可见。测试逐项
限定这3处，拒绝其他裁切或隐藏。首轮源码summary被文本选择器与关闭JSON同时匹配，
修正为真实summary；随后去除不符合全高抽屉物理结构的hidden0预期，保留cut0硬门禁
并增加精确边/面板/gap断言，最终全套通过。暗色1099截图已检查，标题/关闭固定、
正文/主张/来源可读且无水平溢出。整体检查器与执行计划仍未完成。
