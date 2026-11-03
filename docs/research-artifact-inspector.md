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
`readProductionInputFile` 边界校验和读取。助手入口、类型模块、叠加面板、焦点恢复和
人工闸门的版本绑定是后续增量；当前主合同不声称完成整个检查器交互。

## 本增量验证

unit813/813、相关25/25、最终bridge/refusal4/4、Harness94/94、fresh build/typecheck、
native13/13、现有来源/候选renderer23/23、最终启动12/12、IPC/chunks1131153bytes6files
和diff通过。最终4项包括项目缺失的准确not_found分类。之前native13/unit813仍覆盖
数据读取与严格证据消费者；最终错误分类修正不改变保存内容或发布行为。
日志`.artifacts/research-optimization/xui-inspector-*.log`保留；原生工作流每个真实
完成工件的只读快照位于`p0-production/<taskId>/artifact-inspections.json`，校验实际
来源任务/内容运行对应且读取前后数据库total_changes不变。没有真实模型质量、
真实外部客户端或新检查器UI验收的完成声明。
