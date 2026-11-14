# 内置技能源（Built-in skills）

Roc 内置十一阶段研究 Skill，并提供两个可安装的上游技能源。两者使用不同的加载和更新合同。

## 阶段 Skill

[`resources/research-skills/`](../resources/research-skills/) 的每个阶段包含正文、`skill.manifest.json`、许可和评测要求；`catalog.json` 保存封闭资源 bundle。`ResearchSkillRegistry` 核对完整阶段集合、角色、输入/输出 schema hash、内容 hash、许可和能力要求，再加载对应内容；恢复时还核对冻结的 Skill pin。缺失或漂移均拒绝，不回退到原始正文。

聊天与阶段角色共用上下文装配，实际权限仍由角色、run Manifest 和执行授权共同约束。维护取舍见 [ADR 0030](adr/0030-required-skill-contracts.md)，检查入口为 `pnpm check:skills`；改动正文须同步其 Manifest 和 bundle，不能只改 Markdown。

## 可安装的上游技能源

以下两个仓库随安装包提供快照，并在运行时按上游提交自动同步：

| 来源 | 仓库 | 许可证 | 默认安装 |
| --- | --- | --- | --- |
| Nature Skills | `https://github.com/Yuan1z0825/nature-skills` | Apache-2.0 | 是（装好即启用） |
| Academic Research Skills | `https://github.com/Imbad0202/academic-research-skills` | CC BY-NC 4.0 | 否（需在管理 → 技能里明确安装） |

许可证边界见 [CONTEXT.md](../CONTEXT.md#技能许可)：CC BY-NC 4.0 的内容不能作为 Roc 核心开源内容默认分发，
所以它同样是内置快照（离线可用），但**只有用户点「接受 CC-BY-NC-4.0 并安装」之后**才会写入
`~/.roc/skills`，之后才会参与自动同步。

## 文件在哪

| 位置 | 作用 |
| --- | --- |
| `resources/builtin-skills/catalog.json` | 单一真理源：仓库、ref、许可证、`skillRoot`、`supportDirs`、内置提交号与快照 sha256 |
| `resources/builtin-skills/<sourceId>.tar.gz` | 内置快照。压缩存放，避免把上游自带的 Python/JS 工具链当成 Roc 源码扫描 |
| `~/.roc/skills/<skillId>/` | 安装后的技能（Deep Agents 只认这一层） |
| `~/.roc/skills/_bundles/academic-research-skills/shared/` | Academic 技能引用的共用参考资源 |
| `~/.roc/config/builtin-skills.json` | 同步状态：已安装提交、上次检查、ETag、许可接受时间、上次错误 |

`~/.roc/skills/<skillId>/roc.skill.json` 归技能自己：`enabled` 是用户的开关，`origin/sourceId/upstreamRepo/upstreamCommit`
是来源。更新只改来源字段，**不会**把用户关掉的技能重新打开。

安装范围按上游的技能安装方式收窄：

- [Nature 安装说明](https://github.com/Yuan1z0825/nature-skills#5-安装)：复制 `skills/` 下包含 `SKILL.md` 的技能目录，保留 `nature-shared` 共享技能。
- [Academic 安装说明](https://github.com/Imbad0202/academic-research-skills/blob/main/docs/SETUP.md)：复制 `academic-paper`、`academic-paper-reviewer`、`academic-pipeline`、`deep-research`、`sr-screener` 五个技能目录；其引用的 `shared/` 资源也保存在 Roc 的技能目录内。
- 保留技能自身的 `references/`、`scripts/`、`agents/`、资产等内容，不执行其中的安装脚本。不复制仓库根部的 `agents/`、`commands/`、`hooks/`、`tools/`、`scripts/`、`docs/`，也不注册插件、MCP 或安装 Python/Node 依赖。

除 Roc 自身的同步状态外，安装文件都位于 `~/.roc/skills`（设置 `ROC_DATA_ROOT` 时为对应根目录下的 `skills/`）。
旧快照重装也使用当前 `supportDirs` 白名单；替换该来源的 `_bundles` 时，会移除旧版本带入的额外支撑目录。

## 为什么安装是「压平 + 改链接」

Deep Agents 的技能发现只扫 `skillsDir` 的一层子目录，所以每个技能必须落在 `~/.roc/skills/<id>/`。
上游不是这个形状：

- nature-skills 的技能在 `skills/<id>/`，并跨技能引用 `../nature-shared/core/…`；
- academic-research-skills 的技能在仓库根部的 `<id>/`，并同时引用 `../../shared/…`、`../academic-paper/…`
  和行内代码里的 `shared/references/…`。

安装时 `src/main/services/builtin-skills/links.ts` 把每个文件映射回它的上游仓库路径，解析引用，再把引用改写成
安装后的相对路径（支撑目录改指 `_bundles/<sourceId>/…`，兄弟技能仍指 `../<sibling>/…`）。只有在目标确实
存在时才改写，所以上游本来断掉的链接仍然保持断掉，不会悄悄指向别处。

## 同步节奏

- **启动时**：如果内置快照的提交号变化（Roc 升级），或本机从未安装，就从快照安装。离线可用。
- **每 24 小时**：用 GitHub commits API 比对 `main` 的提交，带 ETag；变了就下载 `codeload` tar.gz、
  解包、发现 `SKILL.md`、按同一套压平/改写规则安装。只更新已经安装的来源。
- **手动**：「管理 → 技能 → 立即检查更新」调用 `skills.builtin.check`（`force:true` 忽略 ETag）。
- **重新安装内置版本**：校验并安装随应用打包的快照，完成后显示来源名称和技能数，并刷新列表、文件树及当前预览。同一提交也会重新写入文件，保留用户的启停开关；安装失败会显示错误，不显示成功提示。
- 自动检查可在同一面板关闭（`skills.builtin.autoUpdate`）。

安装是逐技能原子替换：先写 `~/.roc/skills/.builtin-staging-*`，再 `rename` 到目标；失败时保留旧版本。
支撑目录整体替换，因此上游删掉的文件不会残留。

## 重新生成内置快照

```bash
pnpm sync:builtin-skills                     # 两个来源，取各自 ref 的 HEAD
pnpm sync:builtin-skills --source=nature-skills
pnpm sync:builtin-skills --from-dir=/path/to/checkout --commit=<sha>
```

脚本会更新 `catalog.json` 的提交号与 sha256，并重写两个 `.tar.gz`。**改了内置快照就要提交这两个文件**，
否则打包出的 app 里内置版本与实际快照不一致。运行时 `BuiltinSkillsService` 会在安装前校验 sha256。
空快照会被拒绝，不会据此清除已安装技能。

## 验证安装

在仓库根目录执行：

```bash
node --test tests/unit/builtin-skills.test.mjs tests/unit/renderer-management.test.mjs
pnpm build
node --test tests/renderer/builtin-skills.test.mjs tests/integration/builtin-skills-electron.test.mjs
pnpm check:renderer-chunks
```

Electron 集成测试使用独立的临时 `ROC_DATA_ROOT`，通过管理面板安装真实内置包，验证成功提示、技能可识别、
同版本重装恢复文件、用户开关及自建技能保留、安装目录范围；不会修改现有 `~/.roc`。

## 数据与安全

- 上游代码是**下载物**，不是 Roc 源码：解包有路径越界检查、条目数与总字节上限。
- 技能目录对 agent 只读（`ReadOnlyFilesystemBackend` / `SelectedSkillsFilesystemBackend`），agent 不能改技能。
- 技能里的脚本仍由用户/agent 按需执行；来源、提交和许可证在管理面板可见，便于审计。
- 删除一个内置技能只在下次快照提交变化时才会回来；想立刻恢复用「重新安装内置版本」。
- 阶段运行会按 `selectedSkillIds` 收窄技能根目录，此时只读得到被选中的技能；`_bundles/` 与未选中的兄弟技能对
  该次运行不可见（通用研究助手不受此限制）。跨技能引用在阶段运行里因此可能读不到，这是选择收窄的预期行为。
