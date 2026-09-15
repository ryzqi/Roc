# Renderer 5k：主张与正文

状态：Verified passing。基点：`af4b53f`。

## 范围

- 科研页增加正文视图：创建 writing 阶段 manuscript 产物。
- 可为正文添加段落主张，绑定证据，再按章节保存生成的 LaTeX。
- 不在本增量接入主张修订历史、多章节编排或导出闸门预检 UI。

## Standards / Spec

硬违反 0，判断项 0，未解决 0。创建正文会进入 writing 阶段。主张走 `createClaim`，正文走 `saveManuscript`。已支持主张必须选择证据。

独立回归：research-view 13/13，含创建主张并保存 LaTeX。

## 验证

```bash
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test /Users/Apple_501/Desktop/Roc/Roc/tests/renderer/research-view.test.tsx
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc exec tsc --noEmit -p tsconfig.json
```
