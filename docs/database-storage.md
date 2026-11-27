# 数据库存储

Roc 的七个 SQLite 数据库由 `DatabasePool` 管理，默认根目录为 `~/.roc/plugin-data`。
Core 位于 `data/core.db`，插件库位于 `data/plugins/@roc/plugin-<name>.db`。
当前版本和结构以[数据库定义](../src/main/infrastructure/database-schemas.ts)为准，Wiki 的表定义见 [wiki-schema.ts](../src/main/infrastructure/wiki-schema.ts)。

空库在单个事务内直接创建当前表、索引、触发器与 `schema_metadata`。
已有库必须具有匹配的结构、数据库身份、版本和结构校验和；重复打开不改写数据或元数据。
版本号相同也不能替代结构和校验和验证。
启动时先取得数据库维护租约，检查七库版本，然后才运行快速校验和加载插件。
当前支持 **Research v71～v77 自动升级到 v78**：升级前验证冻结的历史结构校验和、
SQLite 完整性及历史执行记录，使用 SQLite Backup API 在 `plugin-data/schema-backups/upgrade-*/`
保存原始数据库，完成备份验证后才在单个事务内升级表、索引、触发器及版本元数据。
迁移连接保留来源的 journal mode，只设置连接级外键、超时及同步参数；事务失败时原库字节与
journal mode 保持不变，迁移提交后由正常启动的 `DatabasePool` 配置 WAL。
备份或备份验证失败时只清理本次新建的不完整备份目录；已完成的备份保留供恢复。
升级完成仍使用原有严格结构校验；重复启动不会重复迁移，也不会重复备份。
v71～v75 的历史 TypeScript 执行快照必须满足当前 strict 合同，并匹配 run、project、request 与 status 的
关系身份；不改写原快照或已有回执。涉及旧 Python 环境选择、Python/R/Julia 执行历史，或未知、
损坏、身份不匹配的执行快照时，在备份和原库写入前拒绝自动迁移并保留原库，
交由离线迁移工具处理；未知历史版本、意外 DDL、未来版本和损坏数据库同样拒绝自动修改。
自动迁移 **不删除用户业务数据**，也不为不支持的结构猜测转换规则。
v77 增加永久删除清理回执与 PDF 发布记录，v78 增加本地文档导入批次及逐文件状态表。

后续结构变更必须按版本增加受控迁移路径；不能只修改当前 DDL 或修改元数据版本号。
对应的冻结结构检查见 `tests/unit/database-migrations.test.mjs`，Release CI 强制运行。

`pnpm database:backup` 和 `pnpm database:restore` 使用构建后的维护 CLI；恢复来源同样必须符合当前结构。
维护操作使用互斥租约，完整性检查覆盖 SQLite integrity 与外键。

显式离线更换不兼容库时，先停止 Roc、取得维护租约并用 SQLite 原生备份保存七库；
上述维护 CLI 要求当前结构，不能用于备份或恢复不兼容的旧库；
启动迁移使用独立的旧版备份入口，因此不受此限制。
在临时库创建当前结构，转换并核对业务数据、重建派生索引，通过结构、完整性和外键检查后
原子替换不兼容库。工具拒绝任何 WAL/SHM/journal 侧文件；应使用对应历史版本安全
完成 checkpoint 并关闭连接，不能删除尚未处理的侧文件。
替换后用实际数据根启动最新应用并复查数据；已符合当前结构的库无需重建。

自动迁移拒绝的 Research 历史库仍可通过 `scripts/database/` 的离线工具处理。
在 macOS 上先停止 Roc，并将旧 Research
库和其项目文件完整复制到隔离的数据根；不要对用户数据目录直接运行验收脚本。使用新建、空的
输出目录运行 `node scripts/database/migrate-research-schema.mjs --data-root <隔离数据根> --output <新迁移目录>`，
随后运行 `node scripts/database/verify-research-migration.mjs --migration <迁移目录>`。构建当前应用后，
运行 `node scripts/database/verify-research-migration-startup.mjs --migration <迁移目录>`；只有启动收据与构建哈希
匹配时，才可在核准的数据根执行 `node scripts/database/publish-research-migration.mjs --data-root <隔离数据根> --migration <迁移目录>`。
发布会替换指定数据根中的 Research 数据库；离线验收入口
`node scripts/verify-research-schema-migration.mjs <全新输出目录>`只操作它新建的合成数据，不触碰 Roc 用户数据。
v76 将旧 Python 选择表替换为当前环境回执表，并新增准备操作状态表。旧选择表必须为空；非空时工具返回 `migration_python_receipts_require_archive`，不会推断删除授权或转换为新回执。旧 Python 实验执行记录也返回 `migration_python_history_requires_archive`，避免复制无法由当前运行合同解码的历史。新环境与操作表保持空，用户之后按当前合同准备项目。

迁移按已授权范围移除 R/Julia 的实验 runs、executions、results 行，并在验证报告中记录逐表 ID、行号、数量和原始指纹。它只接受明确的结构化引擎身份；已发布工件、图稿或其他业务记录引用这些历史时返回 `migration_unsupported_history_referenced`，在生成候选前停止，避免删除无关结果或留下断链。其余表和保留行逐字、逐列及 rowid 核验，原库与备份均不修改。该清理仅属于离线迁移，不给应用增加旧执行或回执兼容路径。
存在待删除历史时，工具还冻结同一数据根的 Agent 库离线副本，检查科研任务关联、事件、消息和检查点中的引用；存在引用则拒绝，不删除 Agent 历史。发布前重验 Agent 原库哈希或其原先不存在的状态，之后新增或修改 Agent 历史都需要重新准备迁移。没有待删除历史时不读取或复制 Agent 库。

各版本的来源快照、输入文件哈希和来源提交记录在 `scripts/database/schemas/manifest.json`。

科研文档重解析后的来源定位候选属于当前业务数据，仍按[证据来源合同](research-evidence-relations.md)保存和审核。

验证入口：`node --test tests/unit/database-schema.test.mjs tests/unit/database-migrations.test.mjs tests/unit/research-schema-migration.test.mjs tests/unit/research-paper-card-versions.test.mjs tests/unit/research-scientific-generations.test.mjs`，
覆盖七库初始化、只读重开、历史库自动升级、数据与 FTS 保留、快照身份拒绝、事务失败时原库字节
与 journal mode 保留、备份失败清理，以及历史卡片和科学代次恢复。PR CI 运行这些回归；
打包后仍须使用隔离的、已有历史内容的数据根验证实际启动，空数据根的 smoke 不能替代该检查。
