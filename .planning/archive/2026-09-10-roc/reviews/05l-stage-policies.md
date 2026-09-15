# Renderer 5l：阶段模型策略

状态：Verified passing。基点：`8256796`。

## 范围

- 科研页增加阶段模型视图：列出各阶段档位和当前模型。
- 可保存 fast/balanced/deep，以及应用默认或指定提供商/模型覆盖。
- 不在本增量接入实时运行策略预览或按角色拆分策略。

## Standards / Spec

硬违反 0，判断项 0，未解决 0。指定模型必须同时选择 providerId 和 modelId。步数和超时按现有 schema 边界校验。

独立回归：research-view 14/14，含保存指定模型覆盖。

## 验证

```bash
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test /Users/Apple_501/Desktop/Roc/Roc/tests/renderer/research-view.test.tsx
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc exec tsc --noEmit -p tsconfig.json
```
