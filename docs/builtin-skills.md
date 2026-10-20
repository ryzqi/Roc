# 内置技能源（Built-in skills）

Roc 把两个上游 Skill 仓库**随安装包内置**，并在运行时按上游提交自动同步：

| 来源 | 仓库 | 许可证 | 默认安装 |
| --- | --- | --- | --- |
| Nature Skills | `https://github.com/Yuan1z0825/nature-skills` | Apache-2.0 | 是（装好即启用） |
| Academic Research Skills | `https://github.com/Imbad0202/academic-research-skills` | CC BY-NC 4.0 | 否（需在管理 → 技能里明确安装） |

许可证边界见 [CONTEXT.md](../CONTEXT.md#许可)：CC BY-NC 4.0 的内容不能作为 Roc 核心开源内容默认分发，
所以它同样是内置快照（离线可用），但**只有用户点「接受 CC-BY-NC-4.0 并安装」之后**才会写入
`~/.roc/skills`，之后才会参与自动同步。

## 文件在哪

| 位置 | 作用 |
| --- | --- |
| `resources/builtin-skills/catalog.json` | 单一真理源：仓库、ref、许可证、`skillRoot`、`supportDirs`、内置提交号与快照 sha256 |
| `resources/builtin-skills/<sourceId>.tar.gz` | 内置快照。压缩存放，避免把上游自带的 Python/JS 工具链当成 Roc 源码扫描 |
| `~/.roc/skills/<skillId>/` | 安装后的技能（Deep Agents 只认这一层） |
| `~/.roc/skills/_bundles/<sourceId>/<dir>/` | 上游仓库根部的支撑目录（`shared/`、`scripts/`、`tools/` 等） |
| `~/.roc/config/builtin-skills.json` | 同步状态：已安装提交、上次检查、ETag、许可接受时间、上次错误 |

`~/.roc/skills/<skillId>/roc.skill.json` 归技能自己：`enabled` 是用户的开关，`origin/sourceId/upstreamRepo/upstreamCommit`
是来源。更新只改来源字段，**不会**把用户关掉的技能重新打开。

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

## 数据与安全

- 上游代码是**下载物**，不是 Roc 源码：解包有路径越界检查、条目数与总字节上限。
- 技能目录对 agent 只读（`ReadOnlyFilesystemBackend` / `SelectedSkillsFilesystemBackend`），agent 不能改技能。
- 技能里的脚本仍由用户/agent 按需执行；来源、提交和许可证在管理面板可见，便于审计。
- 删除一个内置技能只在下次快照提交变化时才会回来；想立刻恢复用「重新安装内置版本」。
- 阶段运行会按 `selectedSkillIds` 收窄技能根目录，此时只读得到被选中的技能；`_bundles/` 与未选中的兄弟技能对
  该次运行不可见（通用研究助手不受此限制）。跨技能引用在阶段运行里因此可能读不到，这是选择收窄的预期行为。
