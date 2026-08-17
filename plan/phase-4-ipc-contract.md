# 阶段 4：IPC 契约单源化

强度：Strong（长期杠杆最高——每个新功能都要过这条链）。依赖：无，可与主工作线并行（注意不要与阶段 1/3 同时改 `chat-transcript.ts`）。

## 问题

**传输层**：一个 channel 穿越 5 个文件、3 套命名，生成器只生成名字不生成类型：

- `src/shared/ipc-schema.json`（key + channel 名）→ `src/shared/ipc-generated.ts:5-113`（仅 channel 字符串常量）
- `src/shared/ipc.ts:124-268` 手写 `RocPreloadApi` 类型
- `src/preload/index.ts:4-178` 手写一一映射转发（179 行，interface 复杂度 = implementation 复杂度，标准浅模块）
- `src/main/ipc/plugin-capability-adapter.ts:40-141` 手写 channel→capability 映射表
- 同一操作三个名字：`tasks.getSnapshot` / `roc:tasks:get-snapshot` / `task.snapshot.get`
- 加一个 channel 至少改 4 个文件；`tests/main/preload-contract.test.ts:25-60` 只能断言 key 树形状（手写转发无法从 schema 推导断言）
- 传输 adapter 里藏语义规则：`plugin-capability-adapter.ts:196-212` 静默剥掉 `shellAllowedCommands` / `signal` / `allowedCommands`

**内容层**：schema/类型多处重复定义：

- 事件 payload 定义为 `z.unknown()`（`src/main/plugins/task/contracts.ts:55`），渲染端用约 350 行 `Reflect.get` 鸭子 guard 重建每种 payload 形状（`src/renderer/chat-transcript.ts:146-363`）
- `ChatStartRunRequest`：shared 类型 + `plugins/agent/index.ts:78-90` 再写一份 zod（index.ts 内共 23 个 `z.object` 重复 shared 类型）
- `RunCapabilityManifestV1`：TS 类型 + zod 全量重写（`run-execution-snapshot.ts:21-62`）
- `AgentLangSmithTraceSessionV1`：类型与 zod 分居两文件
- usage 五元组（input/output/total/cacheRead/cacheCreation）定义 4 次：adapter、`stream-usage-accumulator.ts:3-10`、`run-telemetry.ts:80-87` 与 `:23-33`；`deep-agent-executor.ts:432-439` 手工逐字段搬运

## 目标形态

zod schema 为唯一事实源：

1. 每个 channel 的 request/response/事件 payload 用 zod 定义一次（payload 用 discriminated union），TS 类型全部 `z.infer` 导出——删除所有平行手写类型。
2. 生成器（`scripts/generate-ipc-schema.mjs`）从 schema 产出：channel 常量、preload 转发、channel→capability 映射。手写的 `preload/index.ts` 转发与 adapter 映射表删除。
3. 字段裁剪在 capability 输入 schema 里显式声明（`.omit()` / `.strip()`），不再藏在传输 adapter。
4. usage 五元组收敛为一个共享值对象（`src/shared/types/` 下单点定义），四处消费方引用之。
5. 主/渲染两侧共享同一 payload 解析器，渲染端 350 行鸭子 guard 删除。

## 实施步骤

1. 先做内容层最小闭环：把 task 事件 payload 从 `z.unknown()` 改为 discriminated union（interrupt/approval/subagent 各一支），renderer 引用同一 schema 解析——验证共享解析器的构建/打包路径可行（shared 目录已跨进程使用，风险低）。
2. usage 值对象统一（独立小步，可先行）。
3. 设计 schema 单源的组织方式（见设计决策），迁移 `ipc-schema.json` 内容。
4. 改写生成器：产出类型化 preload 转发与映射表；`pnpm generate:ipc` + `pnpm check:ipc` 纳入验证。
5. 删除 `preload/index.ts` 手写转发、`ipc.ts` 手写 `RocPreloadApi`、adapter 手写映射表、`plugins/agent/index.ts` 等处的重复 zod。
6. 字段裁剪迁入 capability 输入 schema，并为每处裁剪写一行注释说明为什么裁（这是之前藏在 adapter 里的业务规则，显式化后要可追溯）。
7. `preload-contract.test.ts` 改为从 schema 推导断言；渲染端 guard 测试删除。

## 设计决策（动工前定案）

- **schema 源放哪**：继续 JSON（`ipc-schema.json`）还是改为 TS zod 模块作源、生成器改为从 TS 导出读取？建议 TS zod 作源（payload 联合类型用 JSON 表达不现实），`ipc-schema.json` 退役或由 TS 源生成。
- **三套命名收敛到几套**：channel 名与 capability 名是否合一？建议保留两套（wire channel 与 capability 语义名），preloadMethod 名从 channel 派生规则生成——三降二，映射由生成器维护。

## 验收

- 新增一个 channel 只改 schema 一处，`pnpm generate:ipc` 后 preload/映射/类型全部就位。
- 全仓 grep：`z.unknown()` 不再出现在事件 payload；usage 五元组只有一处定义；`Reflect.get` 在 `chat-transcript.ts` 的 guard 段删除。
- `pnpm check:ipc`、`pnpm typecheck`、`pnpm test` 全绿；preload-contract 测试变为推导式。
