# 科研资源与 DataCite 元数据观察

X-ECO A3A 在现有科研插件中新增 ResearchResource 元数据观察。数据集和软件 DOI 保存为独立资源，使用已有检索传输、主机治理和缓存；不会导入论文、下载内容或改变科研审批。A3B 增加论文及实验的显式版本关联，资源 UI 属于后续独立增量。

## 官方合同

核对日期为 2026-11-06，仅表示本次读取日期。

- [DataCite Public API](https://support.datacite.org/docs/api) 和 [GET DOI](https://support.datacite.org/reference/get_dois-id)：使用 JSON API v2 的 `/dois/{doi}`，仅读取公开 findable 记录。404 表示本次公开元数据不可用，不认定 DOI 在全球不存在。没有使用废弃 v1 API。
- [DataCite Metadata Schema 4.7 version](https://datacite-metadata-schema.readthedocs.io/en/4.7/properties/version/)：保存 Provider 报告的原始版本，不推断最新版本。`reportedSchemaVersion` 保留返回值；通用 kernel-4 URI 不被解释为具体 4.7 注册版本。
- [Rights](https://datacite-metadata-schema.readthedocs.io/en/4.7/properties/rights/)：保存 rights、rightsUri、rightsIdentifier、rightsIdentifierScheme、schemeUri 和 lang。许可元数据不是内容下载或再分发授权。
- [RelatedIdentifier](https://datacite-metadata-schema.readthedocs.io/en/4.7/properties/relatedidentifier/)：保留资源 A → B 的原始标识类型、relationType、resourceTypeGeneral、relationTypeInformation 和元数据 scheme 字段。4.7 的额外关系说明为自由文本，不转换成已验证科研结论。
- [限流](https://support.datacite.org/docs/rate-limit)：官方匿名配额为每 IP 每 5 分钟 500 次。产品沿用较保守的每主机 1 请求/秒、300 请求/小时，不配置虚构邮箱或凭据。

外部响应选择已声明字段，核对 data.type、data.id、attributes.doi、findable 状态和 Dataset/Software 类型；JournalArticle 等其他资源类型拒绝。缺省 version、rights 和 relatedIdentifiers 保存为 null；已报告的空集合保存为 []，两者不混用。

## 不可变观察与读取

每次捕获显式提供 projectId、requestId 和 DOI。DOI 使用现有规范化函数，项目须存在且未归档。保存请求、查询时间、端点、元数据、获取时间、原始响应哈希、实际 GET 回执、缓存命中和治理观察。失败保存为 error 观察，metadata 为 null；取消和关闭不保存迟到结果。

相同项目和 requestId 精确重放已保存观察；进行中的相同请求共享作业，修改 DOI 拒绝复用标识。新查询使用新 requestId。归档后仍可读取旧观察，但不能捕获新观察。

数据库迁移 53 仅新增 `research_resource_observations` 和项目/DOI 索引，不推断既有文献或实验的资源关系。规范化 JSON 的 SHA-256 绑定物理行 id、项目、requestId、DOI、端点及主机；读取重新校验完整记录。

四个生成式 IPC 方法为 `captureResource`、`cancelResourceCapture`、`getResourceHistory` 和 `getResource`。捕获只返回摘要，历史每页最多 50 条，关系每页最多 100 条。标题最多 32 个、许可最多 64 个、关系最多 10000 个；超限失败，不截断成成功。

## 传输边界

DataCite 只加入主进程元数据 Provider 类型，论文搜索 source 枚举仍只接收论文来源。内部读取复用 `LiteratureSearchService.readProviderJson`，没有独立下载通道。

HTTPS 端点须与对应 Provider 主机一致，重定向拒绝。单次期限 15 秒，包含等待配额；429/5xx 最多 3 次，普通传输错误不重试。流式响应最多 4 MiB，超限取消 body reader。缓存最多 32 条、总计 8 MiB、TTL 5 分钟，按 projectId/URL/Accept 隔离；完整身份与映射验证通过后才写入缓存。

主进程注册、插件能力清单和 shutdown 已接入。服务关闭会撤销进行中作业，等待结果结束，清空插件资源引用。

## 验证记录

工作目录：`/Users/Apple_501/Desktop/Roc/Roc`。日志位于 `.artifacts/research-optimization/xeco-a3a-*.log`。

`pnpm generate:ipc` 和 `pnpm build`（包含 typecheck）通过。相关单元检查：

```bash
node --test --test-timeout=30000 --test-reporter=tap \
  tests/unit/research-resources.test.mjs \
  tests/unit/research-scholarly-relations.test.mjs \
  tests/unit/literature-import.test.mjs \
  tests/unit/database-migrations.test.mjs
```

130/130 通过。资源的 14 项回归覆盖身份/schema/类型/缺省、404、429、传输失败、流式超限、超时、精确重放、并发、取消、关闭、归档迟到、分页、物理行身份、共享配额、缓存项目隔离、HTTPS、迁移和实际能力/严格 IPC。

搜索账本回归 `node --test --test-timeout=30000 --test-reporter=tap tests/unit/research-review-search.test.mjs`，14/14 通过。主机治理回归包含在上述 `literature-import` 和资源单元检查中。`pnpm harness:eval` 94/94 通过。

新增实际 Electron/原生 SQLite 场景验证 101 条关系分页、严格能力输入、越权项目拒绝、备份后重新打开数据库和精确重放。回执与数据库保存在 `.artifacts/research-optimization/xeco-a3a-native/`。响应是隔离合成数据，未调用真实 DataCite、未下载内容。

最终 `pnpm test:unit` 1328/1328、`node scripts/run-research-p0.mjs` 14/14 通过。历史 Journal 迁移测试固定升级范围为 50→51，保留账本及空记录断言；其专项 12/12 通过，初次全量中的版本断言失败及修正后日志分别保留为 `xeco-a3a-unit.log` 与 `xeco-a3a-unit-final.log`。

相关 renderer 命令 `node --test --test-concurrency=1 --test-timeout=60000 --test-reporter=tap tests/renderer/scholarly-relations.test.mjs tests/renderer/paper-reader.test.mjs tests/renderer/literature-review.test.mjs tests/renderer/artifact-production.test.mjs`，50/50 通过。`node scripts/smoke-electron.mjs` 13/13 且零 renderer 错误，`pnpm check:ipc`、`pnpm check:renderer-chunks`（1134468 bytes / 6 eager files）和最终 diff 空白检查通过。

状态：**Verified passing**（A3A 本地元数据核心）。A3B 关联合同见下文，资源 UI 属于独立增量；没有真实科研数据科学性验收。

## A3B 显式关联

关联是追加保存的 `user_declared_context` 人工相关性声明。请求绑定成功观察的 resourceId/contentHash，以及主进程提供的目标身份。它不证明下载了哪些字节、实际使用了哪个数据集，也不改变审批。

论文绑定真实项目 membership、未归档状态、revision、DOI（允许显式 null）及 `{id,revision,metadata,bibliography}` 的哈希。实验只接受当前项目已完成的托管 execution，绑定 inputHash、environment.hash 与完整 schema-parsed execution 哈希；必须具有环境、输入哈希、结束时间、零退出码且无 error。手工登记或未完成实验不能作为目标。

目标分页接口返回主进程计算的身份，每页最多 50 条。人工从当前窗口明确保存 rationale；IPC 参数不接受 actor 或 approved，主进程绑定实际 windowId，并核对 capability/project。数据库迁移 54 新建关联账本，不推断既有关系。事务内在插入前后校验项目、资源及目标版本；插入触发器造成的来源变化会回滚。相同 projectId/requestId 精确重放，不同内容拒绝。

历史/read 返回 `{association,currentState}`，状态为 current、target_changed 或 target_unavailable。论文取消项目关联/归档或托管执行不再存在时标明 unavailable；版本变化标明 changed。保存的记录保持原始目标版本、标题、资源哈希、人工身份、时间和关联哈希。资源或账本损坏明确失败，不能转成 unavailable。归档项目允许旧关联读取及精确重放，不能新增。

实验完成后迟到的 finish 不覆盖终态；publish 添加 artifactId 后完整执行哈希会变化，旧关联显示 target_changed，需要用户明确关联新版本。实验 get 还验证物理行的项目、runId、requestId 和 status 与快照一致。

生成式 IPC 方法：`associateResource`、`getResourceAssociation`、`getResourceAssociationHistory`、`getResourceTargets`。

A3B 状态：**Verified passing**（本地显式元数据关联）。工作目录与上文相同；日志为 `.artifacts/research-optimization/xeco-a3b-*.log`。

```bash
node --test --test-timeout=30000 --test-reporter=tap tests/unit/research-resource-associations.test.mjs tests/unit/research-resources.test.mjs tests/unit/research-experiment-results.test.mjs tests/unit/research-experiment-resources.test.mjs
node --test --test-timeout=30000 --test-reporter=tap tests/unit/research-resource-associations.test.mjs
pnpm test:unit
pnpm harness:eval
pnpm build
node scripts/run-research-p0.mjs --test-timeout=180000
node --test --test-concurrency=1 --test-timeout=60000 --test-reporter=tap tests/renderer/scholarly-relations.test.mjs tests/renderer/paper-reader.test.mjs tests/renderer/experiment-results.test.mjs tests/renderer/artifact-production.test.mjs
node --test --test-concurrency=1 --test-timeout=180000 --test-reporter=tap tests/renderer/experiment-results.test.mjs
node scripts/smoke-electron.mjs
pnpm check:ipc
pnpm check:renderer-chunks
git diff --cached --check
```

相关检查 35/35、最终补充存储检查 16/16、全量单元测试 1342/1342（原先 14 项关联检查；补充 16 项单独通过）、Harness 94/94 和原生 P0 15/15 通过。renderer 初次 47/56 通过，实验结果组 9 项在 60 秒 before-hook 期限内未完成三个真实 CPython 运行的准备，未执行正文；以 180 秒期限单独复跑 9/9 通过，合计 56 项均有通过结果。没有修改产品或削弱断言。构建/类型、启动 13/13 且零 renderer 错误、IPC current、eager 1134468 bytes / 6 files 和暂存 diff 检查通过。

原生新增场景执行真实 TypeScript CSV 分析（A=2、B=4），绑定 input/environment/完整 execution 哈希，保存实际主进程 window 身份，SQLite 备份重开后仍可读取精确关联，并验证 publish 后目标版本变化。回执和数据库保存在 `.artifacts/research-optimization/xeco-a3b-native/`；资源元数据为隔离合成响应，没有真实内容下载或科研质量主张。

## A3C 阅读器资源面板

阅读器的“科研资源”按钮懒加载项目资源面板；与学术关系共用一个最高 55% 的滚动容器，保留正文空间。查询由人工填写数据集/软件 DOI 后触发，提供实际取消、20 条观察历史分页和不可变观察详情。许可六字段、报告版本、缺失字段、空集合、失败观察及 GET/缓存/哈希回执分别显示；原始关系保持来源方向，折叠展示并按 50 条分页，换页保留展开状态。没有内容下载。

人工关联明确选择主进程提供的论文版本或已完成托管实验身份，填写依据后保存。草稿、进行中的保存和未确认回执锁定资源切换及面板关闭；失败后原样重试同一 requestId，或明确放弃草稿重新读取候选。观察查询的未确认请求也固定 DOI 和 requestId，允许精确重试或显式开始新请求。只读项目可查历史、放弃草稿，不能发起或重试写入。项目/论文/资源键及卸载标记隔离迟到回执。关联历史显示当前版本一致、已变化或不可用以及主进程人工身份。

A3C 状态：**Verified passing**（本地资源观察与人工关联 UI）。工作目录：`/Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc`。

```bash
node --test --test-concurrency=1 --test-timeout=180000 tests/renderer/research-resources.test.mjs
pnpm build
node --test --test-concurrency=1 --test-timeout=180000 tests/renderer/research-resources.test.mjs tests/renderer/scholarly-relations.test.mjs tests/renderer/paper-reader.test.mjs tests/renderer/artifact-production.test.mjs
node scripts/smoke-electron.mjs
pnpm check:ipc
pnpm check:renderer-chunks
git diff --check
git diff --cached --check
```

资源 UI 10/10、最终相关 renderer 57/57、构建含类型检查、真实启动 13/13 且零 renderer 错误、IPC current、eager 1134468 bytes / 6 files 通过。650px 浅色/深色默认、hover、展开、终态八次审计 cut=0、hidden=0；截图已人工检查。日志 `.artifacts/research-optimization/xeco-a3c-*.log`，截图、审计和无障碍快照 `.artifacts/research-optimization/xeco-a3c/`。

初轮测试使用 label 文本查找，受 select 的 option 文本及 React textarea 值影响，改用精确控件角色与可访问名称，未放松名称、版本或禁用断言。折叠关系的分页测试发现 loading 时卸载 disclosure 导致换页关闭，已保持 disclosure 挂载并通过原可见性回归。截图验收显式等待真实 `::details-content` 终态，避免将过渡中间帧作为完整展开证据。此增量只改 UI，没有重跑 A3B 全量 unit/Harness/原生实验；其既有结果见上文。所有元数据与目标夹具均为隔离合成数据，真实 renderer/主进程仓库/能力桥参与验证，不声明真实外网内容下载或独立科研质量。
