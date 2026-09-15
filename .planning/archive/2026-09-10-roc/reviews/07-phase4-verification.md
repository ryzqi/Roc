# Phase 4 / 5：验证与交付记录

状态：Verified passing，附已知限制。基点：`e37f4d66`。

Phase 4 初记停在 Renderer 5e（`058f44f` / `9ff0fe25`）。5f–5l 已补齐并提交；本记录按最终代码状态归档。

## 已交付

- Workflow 1–3b、Production 4a–4h、Renderer 5a–5l、Packaging。
- 科研主路径：11 阶段流程、文献库/阅读、Idea Canvas、实验运行、图稿导出、LaTeX 编辑预览、证据捕获、主张/正文、阶段模型策略、随包工具链与许可证校验。
- 4g1–4g3 机器可读验收见 `agent-integration-acceptance.json`，三项均为 `passes: true`。
- 独立 review 覆盖 `reviews/01-*.md` 至 `reviews/06-packaging.md` 以及 Renderer 5a–5l。

## 已运行（按增量记录，未在归档日重跑全套）

- `pnpm typecheck`、`pnpm check:ipc`、`pnpm build`：Phase 4 初记通过。
- 科研相关回归：初记 38 文件 / 276 项通过，34 项按环境跳过。
- Renderer 5f–5l 各自独立 `research-view` 回归与 typecheck 通过；最终界面回归 14/14。
- Packaging：`native-packaging` 20/20。

## 已知限制（明确不在本计划验收）

- 全量 `pnpm test` 仍有既有 chat/agent/backup/code-quality 失败，不属于本计划科研增量。
- `package:dir` / `package:mac` / `smoke:mac` / `smoke:electron` 未完整重跑。打包合同由 native-packaging 覆盖，安装包实机验证留到发布前。
- Intel 实机验证未做。通用二进制构建不等于 Intel 运行通过。
- Zotero 互操作落地为 BibTeX/BibLaTeX/CSL JSON 文件，不接 Zotero API。
- `academic-research-skills` / `nature-skills` / `scipilot-figure-skill` 未原样内置。核心随包 11 个原创阶段 Skill；CC BY-NC 内容不进入标准开源核心。

## Spec

计划要求的科研工作台主路径已交付。Phase 5 交付即本记录。归档后新工作另开计划。
