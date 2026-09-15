# Renderer 5c：Idea Canvas 编辑与晋升

状态：Verified passing。基点：`44cb416`。

## 范围

- 科研页增加构思视图：创建/选择 Idea Canvas，编辑七个字段、优先级和证据引用。
- 保存走版本化 `saveIdeaCanvas`；已加载画布可晋升为新项目。
- 不在本增量做图稿/导出编辑器。

## Standards / Spec

硬违反 0，判断项 0，未解决 0。字段内容与 `fields[].content` 同步更新，保持后端一致性校验。晋升使用当前保存版本。

独立回归：research-view 5/5，含保存并晋升。

## 验证

```bash
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test /Users/Apple_501/Desktop/Roc/Roc/tests/renderer/research-view.test.tsx
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc exec tsc --noEmit -p tsconfig.json
```
