# 研究发现

**Task:** Roc 架构深化重构
**Date:** 2026-09-03

## 架构摩擦点分析

### 1. Run Capability Manifest 编译器
- **当前接口**: 10 参数输入 → 5 字段对象输出
- **调用方重复**: run-harness.ts:129, capability-preview.ts:32 两处构造相同输入
- **测试困难**: 需要完整 McpServerSnapshot[] 和 SkillSnapshot[] fixture
- **深化方向**: Builder pattern + ToolSelectionPolicy 策略对象

### 2. Agent Outbox 投影
- **跨文件流程**: 理解 run_completed → 任务成功需追踪 3 个文件
- **浅投影器**: AgentOutboxProjector 仅 47 行,核心 20 行
- **逻辑泄漏**: task-repository.ts:404 根据 eventType 分支决定状态转换
- **深化方向**: TaskOutboxProjectionStrategy 纯函数

### 3. Chat Transcript 投影
- **调用栈深**: 5 层递归才到核心逻辑 (chat-transcript.ts 821 行)
- **递归泄漏**: upsertTranscriptSubagentBlock 混合查找 + 更新两个职责
- **测试困难**: 需手工构造深层 ChatTranscriptSubagentActivityBlock[] fixture
- **深化方向**: SubagentBlockTree 类 + TaskToolFilterPolicy

### 4. Run Harness 装配器
- **超级函数**: buildRunHarness 139 行,5 个职责
- **依赖注入过深**: RunHarnessServices 8 个依赖透传
- **类型泄漏**: 返回判别联合类型,hook 拦截语义埋在 192-199 行
- **深化方向**: 5 个独立类 + 协调器

### 5. Task Repository 与 Agent History Contract
- **职责重叠**: 两个 repository 都操作 agent 数据库
- **紧耦合**: TaskRepository 17 个方法中 12 个调用 AgentTaskHistoryContract
- **测试困难**: 需准备两个表数据 + mock 契约
- **深化方向**: EventBus 解耦 + BackgroundTaskLifecycle 领域服务

## 项目约定

### TypeScript 配置
- Target: ES2022
- Module: ESNext + Bundler resolution
- Strict mode 启用
- JSX: react-jsx (React 19)

### 测试约定
- 测试位置: `tests/**/*.test.ts`
- Vitest + globals (无需显式 import)
- 超时: 20s

### 命令
- `pnpm dev`: 开发模式
- `pnpm typecheck`: 类型检查
- `pnpm test`: 运行测试
- `pnpm test:watch`: 监听模式
