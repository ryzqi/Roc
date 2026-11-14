# RTK 集成

## 概述

Roc 随包提供 RTK v1.1.0 OSS arm64 binary，供状态查询和命令压缩使用。当前生产命令链与 RTK middleware 的覆盖范围不同：

- 模型的 `run_shell_command`、`run_isolated_read_command`、`run_trusted_host_command` 先经过 shell 策略和执行授权，再分别进入隔离环境或经人工批准的主机执行。三者都按授权绑定的原命令执行，回执为 `usedRtk:false`，不自动改写或转交 RTK。
- `RTKMiddleware` 只拦截 `execute`、`bash`、`shell`、`terminal`，调用 `CommandRewriter` 执行 `rtk rewrite <command>`。Roc 不向模型暴露框架原生 `execute` 工具；随包 binary 可用不代表生产命令输出已经压缩。
- 主机 agent 执行环境可配置 RTK 的 PATH、tracking DB 和 tee 目录；用户终端保留原始输出，标记 `user_terminal_raw_output`。

## 资源位置

Roc 当前只支持 Apple Silicon，并随包提供 arm64 binary。

开发环境：

```text
resources/rtk-binaries/darwin-arm64/rtk
resources/rtk-binaries/darwin-arm64/LICENSE
```

打包环境：

```text
<Roc resources>/rtk-binaries/darwin-arm64/rtk
```

`electron-builder.yml` 通过 `extraResources` 把 `darwin-arm64` 目录复制到应用资源目录。

## 关键模块

- `src/rtk-integration/binary-manager.ts`：只解析 `darwin-arm64` 的 RTK binary 路径并检查可用性；其他架构返回不可用，由调用方降级。
- `src/rtk-integration/rewriter.ts`：调用 `rtk rewrite <command>`，解析 `rtk ...` 参数。
- `src/rtk-integration/middleware.ts`：拦截 LangChain shell 工具调用并改写命令。
- `src/main/services/rtk-service.ts`：向 Roc 状态面板和执行链暴露 bundled RTK binary 状态。
- `src/main/services/deep-agent/command-tool.ts`、`src/main/plugins/agent/run-harness.ts`：生产命令策略、精确命令绑定与授权。
- `src/main/plugins/runtime-tools/index.ts`：消费授权，选择隔离或主机执行环境。
- `src/main/services/shell-execution-service.ts`：主机命令执行、运行环境与输出上限。

## 调试

验证 Apple Silicon binary：

```bash
resources/rtk-binaries/darwin-arm64/rtk --version
resources/rtk-binaries/darwin-arm64/rtk rewrite "git status"
```

完整测试和打包验证见[验证入口](verification.md)；上述 binary 检查不证明生产工具经过 RTK。

## 降级行为

以下仅描述 middleware，不能作为生产命令的授权或降级规则：

- binary 不可用或命令不支持时，调用原 handler。
- `rtk rewrite` 返回 deny（exit 2）时，返回错误 `ToolMessage`，不执行原命令。
- 默认 `fallbackOnError:true`：改写抛错或改写后的 handler 抛错时重试原 handler；handler 返回失败结果本身不触发此回退。

## 版本与来源

- RTK version：v1.1.0 OSS
- Release date：2026-10-25
- Release asset：`rtk-oss-aarch64-apple-darwin.tar.gz`
- Release archive SHA-256：`1623590dd8d65374f61589c599c764c08ba9ce993ebe6b601312a89a3c874558`
- Release source：`https://github.com/rtk-ai/rtk/releases/tag/v1.1.0`
- LangChain middleware API：`https://docs.langchain.com/oss/javascript/langchain/middleware`
