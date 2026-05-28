# Phase 1 Verification

- 执行时间：2026-05-28 15:49:xx Asia/Shanghai
- typecheck：Verified passing（`pnpm typecheck`，exit 0）
- vitest：Verified passing（`pnpm test`，exit 0；95 files / 620 tests passed；测试期间 node-pty 子进程打印 `AttachConsole failed`，但命令 exit 0）
- build：Verified passing（`pnpm build`，exit 0）
- electron smoke：Verified passing（`pnpm smoke:electron`，exit 0；包含 `memoryPhase1PlaceholderVisible=true` 与 `memoryApiReduced=true`）
- targeted DDL regression：Verified passing（`pnpm test -- tests/main/database-memory-rebuild.test.ts`，1 file / 1 test passed）
- DB inspect：Verified passing；`C:\Users\任彦舟\.roc\roc.sqlite` 中旧 memory 表与旧 FTS 表查询结果为 `remaining: []`
- 记忆 UI：Verified passing；Phase 1 显示占位页，旧 candidate/conflict/session recall 视图已删除

## Notes

- Phase 1 是 destructive batch：旧 candidate / conflict / session_recall / `SqliteLangGraphStore` 数据不迁移、不导出、不备份。
- Deep Agents official contract 保留 `createDeepAgent({ store })`，runtime store 临时使用 `InMemoryStore`；`/memory/` 路由改为 `FilesystemBackend` + 只读 wrapper。
- `docs/记忆系统.md` 在执行前不存在，因此没有 legacy 文件可移动。
