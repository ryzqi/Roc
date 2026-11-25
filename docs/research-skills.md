# 阶段 Skill 资源与运行准备

十一阶段从 `resources/research-skills/catalog.json` 的封闭包加载指令。每份 manifest 明确声明入口、私有参考、共享参考、许可、所需能力和只读准备检查；缺项拒绝加载，不回退原始 Markdown。

`sharedReferences` 只允许 `shared/` 下的准确文件，分别记录内容哈希和许可文件哈希。构建脚本以资源根校验真实路径，拒绝越界、符号链接与超限文件；registry 逐份核对哈希和许可。入口或参考中的本地链接必须落在本次已声明的资源集合，不能通过一个共享参考继续读取未声明文件。正文只拼入入口和已声明参考，许可和评测文件仅用于校验。

共享资源不是额外 Skill，也不声明或继承工具。角色白名单、当前运行工具清单、能力授权与 Skill 的 requiredCapabilities 仍共同约束执行。所有 manifest 和共享资源变更参与 `manifestHash` 与 `skillHash`；旧运行恢复、重试与工具执行均重新核对原 pin，更新后的内容需要新运行。

生产注册的 `ResearchStageReadinessService` 在 `executor.prepare` 之前核对所需能力是否存在。`readiness` 为准确的只读探针：

- `figure_renderer` 读取现有 `research.figure.environment` 并验证渲染环境合同。
- `export_toolchain` 读取现有 `research.toolchain.status`，工具链不可用时保存具体领域码并停止本阶段。

缺能力、缺资源或准备检查失败不进入模型，也不创建生产产物。探针成功只代表所查询环境/工具链的报告有效，不证明任意脚本可执行或科学结果已通过审核。实验阶段尚无选定引擎时不猜 Python 或 TypeScript；选定后仍由现有 `inspect_experiment_environment` 核对准确 runtime、锁文件和环境哈希，真实启动再次校验。

阶段准备不安装依赖、执行实验、提交审核或开放网络。方法计划、来源记录与不确定结果遵循共享参考约束，人工科学决定继续使用原闸门。

修改 manifest 或资源后运行：

```sh
node scripts/check-research-skills.mjs --write
pnpm check:skills
node --test tests/unit/research-skill-registry.test.mjs tests/unit/research-stage-readiness.test.mjs tests/unit/research-stage-inputs.test.mjs
```

主助手可选 Skill 的文件闭包见[内置技能](builtin-skills.md)；两条装配路径都保持只读资源与工具授权分离。
