# design-reference（原 `research-studio` 前端）

这是**只读设计参照**，不是可运行的第二个前端。仓库里只有一套前端
（`src/renderer/**`，见 ADR 0022）；本目录保留下来，是因为
[ADR 0023](../docs/adr/0023-motion-parity-with-research-studio.md) 与
[ADR 0025](../docs/adr/0025-alignment-audit-and-cleanup.md) 把它的 UI 定为视觉、版式与动效的**标准**：
逐面对齐时要能直接读到参考实现，而不是凭记忆复述。

## 保留了什么

| 路径 | 为什么留 |
| --- | --- |
| `src/App.tsx` | 壳层与三栏的原始布局（左栏 / 助手 / 画布） |
| `src/components/**` | 逐面对齐的参照：顶栏、左栏、画布 tab 条、转录、面板、抽屉、浮层、文件树与预览 |
| `src/index.css` | 调色板、字号与动效的真身（`tokens.css` / `motion.ts` 由它转录） |
| `src/types/research.ts` | 参考里各面的数据形状 |
| `src/main.tsx` | 入口，说明 `App` 的挂载方式 |

## 删掉了什么，为什么

它是从 Google AI Studio 导出的原型，**导出脚手架与演示数据都不是设计权威**，留着会让「哪一份是真的」
需要重新判断（ADR 0025）：

- `.aistudio/artifacts/brain/<id>/implementation_plan.md`（AI 生成的过程稿）、`metadata.json`、
  `.env.example`（`GEMINI_API_KEY` 模板）、AI Studio 版 `README.md`、`bun.lock`：AI Studio 导出物，
  与 UI 无关；
- `package.json` / `vite.config.ts` / `tsconfig.json` / `index.html` / `.gitignore`：只有「把原型跑起来」
  才需要。删掉之后本目录**不可构建**，这是有意的——可构建会把「第二套前端」的事实重新带回仓库；
- `src/data/mockProjects.ts`、`src/data/mockResearchData.ts`：演示项目、论文、会话、记忆假数据；
- `src/utils/mineruParser.ts`、`src/utils/ragEngine.ts`：模拟解析 / 检索管线，含
  `mineru_demo_token_ak8291` 这类演示密钥。

**因此 `src/App.tsx` 与部分 `src/components/views/**` 对 `../data/*`、`../utils/*` 的 import 现在是
悬空的**，这是刻意的截取边界，不是损坏：需要完整可运行快照时用 Git 历史
（`f6814e44` 纳入、`b0c01e7a` 恢复），或 `git show <commit>:research-studio/...`。

## 怎么用

只读。对齐某个面时读对应的 `src/components/<面>.tsx` 与 `src/index.css`，把结论写进
`docs/adr/0025-alignment-audit-and-cleanup.md` 的清单；**不要**把这里的组件复制进 `src/renderer/**`，
也不要把它的 Tailwind 类名（`rounded-2xl`、`text-[11px]` 之类）当成 token 直接抄进产品代码。
