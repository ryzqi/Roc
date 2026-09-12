# Production 4d2 Review

基点：`b12a88ea64754d9f7b5bde8248dd0e84ebdd391d`。审查差异：`rtk git diff --cached b12a88e`。范围：R/renv 与 Julia 项目环境预检、脚本执行、冻结配置、运行前后环境一致性，以及 R 受限进程适配器。复用已有实验持久记录、日志、输出、取消、证据和流程发布，不改旧 migration。

## Standards

完整审查与修复后的窄复核均无未解决问题：硬违反 0、启发式问题 0。已核对 C 适配器的进程与文件权限、源码和二进制哈希，以及 R/Julia 配置一致性修复。R 从进程启动起处于原沙箱，仍禁止另建进程组、会话及 posix_spawn；适配器只以 fork/exec 支持标准库所需的命令管道。

## Spec

初审复现两项：Julia 优先读取的 JuliaLocalPreferences.toml 未纳入冻结配置；R 的空 R_LIBS_SITE 被系统恢复为额外 site-library。已按 Julia 自身的 preferences/artifacts 文件名列表保存配置，并在 R 预检和执行中显式禁用 site-library。

两项真实回归先失败后通过，窄复核确认最终未解决 0。Julia 同时存在两套偏好时实际运行保持优先值，R 存在额外系统库时也只使用指定库与自带库。

## Verification

- 真实 R/Julia IPC 与 R 进程测试：2 文件、14 项通过，包含实际包环境、过期锁文件拒绝、冻结本地依赖、优先配置、运行取消、子进程回收、管道输出/退出码和越界拒绝。
- 最终科研域、IPC 与预览协议：31 文件、202 项通过；25 项可选真实资源用例在常规命令下按环境跳过，R/Julia 用例已通过上面的显式资源命令执行。
- `build`（含 typecheck）、`check:ipc`、暂存差异检查通过。私有 Python 工具链 38,565 项完整性通过；没有覆盖现有工具链或重新下载 TeX。
- 真实证据保留在 `.artifacts/research-native-experiment-integration/`。R/Julia 运行时仅在私有测试目录解包，未安装到系统。

```bash
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test /Users/Apple_501/Desktop/Roc/Roc/tests/main/plugins/research /Users/Apple_501/Desktop/Roc/Roc/tests/main/pdf-preview-protocol.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-plugin-adapter.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-contract-boundary.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-schema-generation.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-domain-structure.test.ts
rtk proxy env PYTHONDONTWRITEBYTECODE=1 ROC_RESEARCH_TOOLCHAIN=/Users/Apple_501/Desktop/Roc/Roc/.runtime/research-toolchain/darwin-arm64 ROC_RESEARCH_R_HOME=/Users/Apple_501/Desktop/Roc/Roc/.runtime/research-experiment-tools/R-4.6.1/R-fw.pkg/Payload/R.framework/Versions/4.6/Resources ROC_RESEARCH_R_LIBRARY=/Users/Apple_501/Desktop/Roc/Roc/.runtime/research-experiment-tools/r-library ROC_RESEARCH_JULIA_ROOT=/Users/Apple_501/Desktop/Roc/Roc/.runtime/research-experiment-tools/julia-1.13.0/julia-1.13.0 ROC_RESEARCH_JULIA_DEPOT=/Users/Apple_501/Desktop/Roc/Roc/.runtime/research-experiment-tools/julia-depot ROC_RESEARCH_ARTIFACT_ROOT=/Users/Apple_501/Desktop/Roc/Roc/.artifacts/research-native-experiment-integration pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test /Users/Apple_501/Desktop/Roc/Roc/tests/main/plugins/research/experiment-native-ipc.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/plugins/research/experiment-native-process.test.ts
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc build
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc check:ipc
```

边界：R/Julia 需要已准备的所选项目环境，不自动安装依赖；本地相对 Julia 依赖须显式列入输入。适配器已构建为 arm64/x64 通用库，Intel 实机验证留到 Packaging。图稿、最终导出和完整 Renderer 仍在后续计划。

状态：Verified passing。
