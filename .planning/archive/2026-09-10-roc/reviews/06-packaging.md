# Packaging：科研工具链与许可证随包校验

状态：Verified passing。基点：`745b6ca`。

## 范围

- macOS 安装包把当前架构的 `.runtime/research-toolchain/darwin-${arch}` 复制到 `Contents/Resources/research-toolchain`。
- afterPack 校验清单、关键二进制、TeX bundle 和许可证记录存在，且架构匹配。
- smoke:mac 检查打包后的工具链文件。不把通用二进制构建等同于 Intel 实机通过。

## Standards / Spec

硬违反 0，判断项 0，未解决 0。asar 仍只含 dist/node_modules/package.json；工具链走 extraResources。完整哈希校验仍由运行时 ResearchToolchain 执行。

独立回归：native-packaging 20/20。

## 验证

```bash
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test /Users/Apple_501/Desktop/Roc/Roc/tests/main/native-packaging.test.ts
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc exec tsc --noEmit -p tsconfig.json
```
