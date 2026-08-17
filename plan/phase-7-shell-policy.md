# 阶段 7：Shell 安全 policy 单源

强度：Worth exploring。依赖：无（独立；避免与阶段 3 同时改 `deep-agent-executor.ts` / `runtime.ts`）。

## 问题

同一不变量（"不许 /workspace 虚拟路径、不许 Linux 路径出现在 host shell"）在三个 seam 各自实现一份，错误文案重复但措辞不同：

- tool 层：`src/main/services/deep-agent/shell-path-guard.ts:24-31`（纯函数）+ `command-tool.ts:25-36`（工具 func 内调 guard）
- middleware 层：`shell-path-policy.ts:24-101`（再查一遍 command/cwd，文案与 guard 重复但措辞不同）
- service 层：`shell-execution-service.ts:7`（第三次 `containsVirtualWorkspacePath`）

allowedCommands 的解析与校验也散在两处：`deep-agent-executor.ts:134-147, 814-851`（解析 + execute adapter）与 `runtime.ts:1284-1305`（`resolveShellAllowedCommands` 又一处来源校验）。

改一条规则要同步三处逻辑与文案；`shell-path-guard.ts` 自身无直测（仅经 policy 间接覆盖）。

## 目标形态

**三层纵深防御保留**（安全结构不动），但三层都调用同一个 policy 模块：

- 单一模块（建议 `src/main/services/deep-agent/shell-policy.ts`，合并现 guard + policy 文件）输出判定结果与统一文案：`evaluate(command, cwd, allowedCommands) → { verdict: 'allow' | 'deny', reason?, message? }`
- tool / middleware / service 三层只透传结论，不再各自实现规则或文案。
- allowedCommands 的解析收敛到 policy 模块一处；executor 与 runtime 只传原始配置。

## 实施步骤

1. 对照三处实现，列规则并集与文案差异；差异处逐条确认哪个是对的（措辞不同可能掩盖行为不同——这一步是本阶段真正的排雷）。
2. 建 policy 模块，规则并集 + 统一文案；把 `shell-path-guard.ts` 与 `shell-path-policy.ts` 的实现合入。
3. 三层改调 policy；各层保留调用点（纵深不变），删除本地规则副本。
4. allowedCommands 解析从 executor 与 runtime 收进 policy；两处改传配置。
5. policy 一套直测覆盖全部判定分支 + 文案快照；三层各留一条"确实调用了 policy 且 deny 时拒绝执行"的薄测试。

## 设计决策（动工前定案）

- RTK 集成的命令改写（`CommandRewriter`）发生在 policy 判定之前还是之后？现状是 RTK 改写后的 `rtk ...` 命令由 `ShellExecutionService` 识别执行——policy 应当对改写后的最终命令判定。确认调用顺序并在 policy 模块注释里写明该约束。

## 验收

- 全仓 grep：路径规则与文案只在 policy 模块出现一份；`containsVirtualWorkspacePath` 只有一处定义。
- 三层各自的规则副本删除，但三个调用点仍在（纵深保留）。
- policy 模块有覆盖全部分支的直测；改一条规则只动一个文件。
- `pnpm typecheck` + `pnpm test` 全绿。
