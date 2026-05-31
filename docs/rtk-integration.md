# RTK 集成

## 概述

Roc 集成 RTK v0.42.0，用于压缩 Deep Agents `execute` 工具的 shell 输出。集成路径是：

1. `RTKMiddleware` 通过 LangChain `createMiddleware({ wrapToolCall })` 拦截 shell 工具调用。
2. `CommandRewriter` 调用 bundled RTK binary 的 `rewrite` 子命令，把支持的命令改成 `rtk ...` 形式。
3. `ShellExecutionService` 识别 `rtk ...` 命令，转交 bundled RTK binary 执行。
4. RTK 不可用、命令不支持、或改写失败时，执行链静默回退到原命令。

## 资源位置

开发环境：

```powershell
resources\rtk-binaries\win32-x64\rtk.exe
resources\rtk-binaries\darwin-x64\rtk
resources\rtk-binaries\darwin-arm64\rtk
resources\rtk-binaries\linux-x64\rtk
```

打包环境：

```powershell
<Roc resources>\rtk-binaries\<platform>\rtk.exe
<Roc resources>\rtk-binaries\<platform>\rtk
```

`electron-builder.yml` 通过 `extraResources` 把 `resources\rtk-binaries` 复制到应用资源目录。

## 关键模块

- `src/rtk-integration/binary-manager.ts`：解析当前平台 RTK binary 路径并检查可用性。
- `src/rtk-integration/rewriter.ts`：调用 `rtk rewrite <command>`，解析 `rtk ...` 参数。
- `src/rtk-integration/middleware.ts`：拦截 LangChain shell 工具调用并改写命令。
- `src/main/services/rtk-service.ts`：向 Roc 状态面板和执行链暴露 bundled RTK binary 状态。
- `src/main/services/shell-execution-service.ts`：执行 RTK 命令，设置 RTK 运行时路径、tracking DB 和 tee 目录。

## 调试

验证当前 Windows binary：

```powershell
.\resources\rtk-binaries\win32-x64\rtk.exe --version
.\resources\rtk-binaries\win32-x64\rtk.exe rewrite "git status"
```

运行 RTK 测试：

```powershell
pnpm test tests\rtk-integration\
pnpm test --coverage tests\rtk-integration\
```

运行完整验证：

```powershell
pnpm typecheck
pnpm test
pnpm package:dir
pnpm smoke:electron
```

## 降级行为

- `RTKBinaryManager` 找不到当前平台 binary：middleware 不改写，命令按原路径执行。
- `rtk rewrite` 返回 unsupported：命令按原路径执行，并记录 `command_not_supported`。
- RTK deny：middleware 返回错误 `ToolMessage`，不执行原命令。
- 改写后命令执行失败：默认回退原命令。

## 版本与来源

- RTK version：v0.42.0
- Release date：2026-05-24
- Release source：`https://github.com/rtk-ai/rtk/releases/tag/v0.42.0`
- LangChain middleware API：`https://docs.langchain.com/oss/javascript/langchain/middleware`
