# 数据库存储

Roc 的七个 SQLite 数据库由 `DatabasePool` 管理，默认根目录为 `~/.roc/plugin-data`。
Core 位于 `data/core.db`，插件库位于 `data/plugins/@roc/plugin-<name>.db`。
当前结构定义在 `src/main/infrastructure/database-schemas.ts`；Wiki 的结构单独维护在 `wiki-schema.ts`。

空库在单个事务内直接创建当前表、索引、触发器与 `schema_metadata`。当前版本为
Core 1、Agent 25、Memory 2、Task 1、Workspace 1、Diagnostics 1、Research 71。
已有库必须具有匹配的结构、数据库身份、版本和结构校验和；重复打开不改写数据或元数据。
结构不兼容时返回 `database_schema_current_required`，保留原库，不进行自动升级、回填或重建。
仓库不再提供历史数据库升级脚本、逐版本账本或启动时的一次性转换逻辑。

`pnpm database:backup` 和 `pnpm database:restore` 使用构建后的维护 CLI；恢复来源同样必须符合当前结构。
维护操作使用互斥租约，完整性检查覆盖 SQLite integrity 与外键。
科研文档重解析后的来源定位候选属于当前业务数据，仍按[证据来源合同](research-evidence-relations.md)保存和审核。

验证入口：`node --test tests/unit/database-schema.test.mjs`，覆盖七库初始化、只读重开、
不兼容库拒绝与初始化失败回滚；实际启动由 Electron smoke 验证。
