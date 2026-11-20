# 数据库存储

Roc 的七个 SQLite 数据库由 `DatabasePool` 管理，默认根目录为 `~/.roc/plugin-data`。
Core 位于 `data/core.db`，插件库位于 `data/plugins/@roc/plugin-<name>.db`。
当前结构定义在 `src/main/infrastructure/database-schemas.ts`；Wiki 的结构单独维护在 `wiki-schema.ts`。

空库在单个事务内直接创建当前表、索引、触发器与 `schema_metadata`。当前版本为
Core 1、Agent 25、Memory 2、Task 1、Workspace 1、Diagnostics 1、Research 74。
已有库必须具有匹配的结构、数据库身份、版本和结构校验和；重复打开不改写数据或元数据。
版本号相同也不能替代结构和校验和验证。
结构不兼容时返回 `database_schema_current_required`，保留原库，不进行自动升级、回填或重建。
仓库不提供启动时的一次性转换逻辑或逐版本升级账本。Research v71、v72、v73 到 v74
使用独立离线工具，先生成候选库，再经实际应用启动验证和显式发布；其他历史结构仍拒绝。

`pnpm database:backup` 和 `pnpm database:restore` 使用构建后的维护 CLI；恢复来源同样必须符合当前结构。
维护操作使用互斥租约，完整性检查覆盖 SQLite integrity 与外键。

显式离线更换不兼容库时，先停止 Roc、取得维护租约并用 SQLite 原生备份保存七库；
上述维护 CLI 要求当前结构，不能用于备份或恢复不兼容的旧库。
在临时库创建当前结构，转换并核对业务数据、重建派生索引，通过结构、完整性和外键检查后
原子替换不兼容库。工具拒绝任何 WAL/SHM/journal 侧文件；应使用对应历史版本安全
完成 checkpoint 并关闭连接，不能删除尚未处理的侧文件。
替换后用实际数据根启动最新应用并复查数据；已符合当前结构的库无需重建。

Research 历史库迁移工具位于 `scripts/database/`。在 macOS 上先停止 Roc，并将旧 Research
库和其项目文件完整复制到隔离的数据根；不要对用户数据目录直接运行验收脚本。使用新建、空的
输出目录运行 `node scripts/database/migrate-research-schema.mjs --data-root <隔离数据根> --output <新迁移目录>`，
随后运行 `node scripts/database/verify-research-migration.mjs --migration <迁移目录>`。构建当前应用后，
运行 `node scripts/database/verify-research-migration-startup.mjs --migration <迁移目录>`；只有启动收据与构建哈希
匹配时，才可在核准的数据根执行 `node scripts/database/publish-research-migration.mjs --data-root <隔离数据根> --migration <迁移目录>`。
发布会替换指定数据根中的 Research 数据库；离线验收入口
`node scripts/verify-research-schema-migration.mjs <全新输出目录>`只操作它新建的合成数据，不触碰 Roc 用户数据。
固定 v73 来源快照、输入文件哈希和来源提交记录在 `scripts/database/schemas/manifest.json`。

科研文档重解析后的来源定位候选属于当前业务数据，仍按[证据来源合同](research-evidence-relations.md)保存和审核。

验证入口：`node --test tests/unit/database-schema.test.mjs`，覆盖七库初始化、只读重开、
不兼容库拒绝与初始化失败回滚；实际启动由 Electron smoke 验证。
