# 阶段 6：task-repository 聚合化 + capability 按名注册

强度：Worth exploring。依赖：无（独立线；避免与阶段 8 同时改 task 插件）。

## 问题

**文件内隐形分层**：`src/main/plugins/task/task-repository.ts`（1,692 行）fold-back 重构合并了文件但没合并结构——class（`:50-1026`）大量方法是一行转发到同文件下方约 45 个模块级自由函数（`:1028-1692`）：`findBackgroundTask:120-122` → `readBackgroundTask:1357`，`listBackgroundTasks:128-130` → `readBackgroundTasks:1403`。原来的跨文件 seam 变成文件内 1,400 行滚动；`this.db` 与参数 `db` 双轨并存（`db` 作首参传 16 处）。

**下标注册**：`src/main/plugins/task/index.ts:222-332` 按 `taskCapabilityDescriptors[0]` … `[20]` 逐个注册，descriptor 数组（`:52-74`）与序号位置耦合——中间插一个 descriptor 会静默错位所有后续 handler，编译期不报错。

**测试密度**：`task-repository.test.ts` 仅 416 行对 1,692 行实现；自由函数未导出，claim/reconcile 等复杂路径只能穿透 class interface 测，主要靠 plugin-*.test.ts 集成覆盖。

**附带**：`schema.ts:5-7` 是 7 行纯转发（真实迁移在 `infrastructure/database-schemas.ts:690-808`）——归入阶段 9 清理；表结构下放的问题归阶段 8 议。

## 目标形态

1. 按聚合拆成有独立不变量的子模块，各自拥有自己的 SQL 与直测：
   - `scheduled-occurrence`（含 claim/reconcile 状态机）
   - `background-task`（含 thread 关联）
   - `projection`（快照/列表投影）
2. `TaskRepository` 变为薄组合根：持有连接、组装子模块、暴露既有对外 interface（对外 interface 不变，callers 零改动）。
3. 一行转发消失：要么方法体就是实现（收进 class/子模块），要么子模块方法直接暴露。`db` 传递方式统一为构造注入一种。
4. capability 注册改按 name：`register('task.snapshot.get', handler)` 或 descriptor 自带 handler——错位从运行时静默错误变为编译期/启动期错误。

## 实施步骤

1. 给 45 个自由函数按聚合归类（读代码定归属，孤儿函数并入最近的聚合）。
2. 建三个子模块文件，函数搬入并改为构造注入连接；class 方法的转发改为调子模块（此步行为不变，纯移动）。
3. 消灭一行转发：对外 interface 保持不变的前提下，把 class 方法体内联或直接委托。
4. 为 claim/reconcile、跨库删除 journal 状态机（`:132-176`）补窄 interface 直测——这是本阶段的测试收益主体。
5. 注册改按 name；descriptor 数组与序号解耦；`plugin.test.ts` 加一条"全部 capability 名都有 handler"的断言。

## 设计决策（动工前定案）

- 拆三个还是两个聚合？以第 1 步归类结果为准——若 projection 体量小，可并入 background-task；不为对称而拆。
- thread 删除 journal（`thread-deletion-journal.ts` + 恢复循环 `index.ts:111-123` + 失败广播 `:299-321`）本阶段只补测试不动结构——结构收敛（journal 拥有单一入口）留给阶段 8。

## 验收

- `task-repository.ts` 内不再有"方法体只有一行调用同文件自由函数"的形态；`db` 传递只剩构造注入。
- 注册无数组下标；中间插 descriptor 不会错位。
- claim/reconcile 有窄 interface 直测；task 相关测试对实现的覆盖密度上升（新增直测行数 > 删除的转发行数）。
- 对外 interface 未变：task 插件 callers 与 IPC 层零改动。
- `pnpm typecheck` + `pnpm test` 全绿。
