# 学术关系来源快照

X-ECO A1 在现有科研插件中提供 `ScholarlyRelationsService`。它读取 OpenAlex、Crossref 和 Semantic Scholar 的公开关系元数据，保存不可变的来源观察；没有内容下载或外部写入。

## 固定的官方合同

合同核对时间：2026-11-06。该日期是本次检索日期，不是 Provider 政策生效日期。

- [OpenAlex Work attributes](https://help.openalex.org/data/works/attributes/)：`referenced_works` 为出向引用；`related_works` 为语义邻近作品，不能映射成版本关系。单作品 DOI 查询核对返回的 DOI，保留 OpenAlex 原生作品标识。`is_retracted=false` 保存为 `not_reported`，不认证论文可信或没有撤稿。
- [Crossref 官方响应格式](https://github.com/CrossRef/rest-api-doc/blob/master/api_format.md)：`reference`、`relation`、`update-to` 可缺省。无 DOI 的参考文献计入未映射数量；保留原始关系类型、字段路径和 `asserted-by`。版本类型显式映射，其他类型保留为 `provider_relation`。`update-to.DOI` 指向被更新作品，因此保存通知 DOI → 原作 DOI；类型保留为 correction、retraction 或 Provider 原始关系。
- [Semantic Scholar Graph 文档](https://api.semanticscholar.org/api-docs/graphs)及其[官方 Swagger](https://api.semanticscholar.org/graph/v1/swagger.json)：`/paper/DOI:{doi}/references` 使用 `fields=paperId,externalIds`、`offset`、`limit`。`next` 在分页结束时缺省。没有 DOI 时保留原生 paperId，没有可识别作品时记录未映射。未声明此 API 支持勘误或撤稿。

## 捕获与保存

`captureScholarlyRelations` 必须显式提供 projectId、itemId、expectedRevision、requestId、互不重复的 sources、offset 和 limit。项目及文献须未归档，文献须关联该项目且具备 DOI。非零 offset 只允许单独选择 Semantic Scholar。

每个快照固定文献 DOI/库版本、完整请求、查询时间、来源观察和内容哈希。每个来源保存端点、获取时间、原始响应哈希、缓存状态、实际 GET 回执、治理观察、关系数量、字段是否报告、未映射数量、撤稿观察和下一页位置。失败来源的字段可用性及未映射数量为 null，不能用 false/0 冒充已核查。

成功状态只说明本次所选来源请求成功；它不表示完整书目已穷尽，也不表示科研审核通过。Semantic Scholar 的下一页必须另行显式捕获，不能将独立页面拼成没有共同时间点的权威全量快照。关系本身不改写文献元数据、已批准证据、稿件或阶段审批。

数据库迁移 52 只新增 `research_scholarly_snapshots` 和索引。已应用迁移、已有文献及审批历史保持原值。存储按 canonical schema 序列化后计算 SHA-256；读取核对内容哈希、请求/项目/库版本、物理数据库行身份、来源清单和关系数量。

同一 projectId/requestId 的保存结果精确重放，不再次联网；修改请求字段拒绝复用该标识。来源改变后，旧请求仍可读取原快照，新请求必须使用当前库版本。进行中的精确重复请求共享一个作业。取消或服务关闭会中止请求并阻止迟到保存；取消的未保存请求没有成功回执。新查询使用新 requestId。

## 网络与读取边界

沿用 `LiteratureSearchService` 的内部 JSON 读取，复用已有主机治理、缓存、取消和关闭过程。不存在第二个缓存或绕开配额的抓取通道。

- 主机默认 1 请求/秒、300 请求/小时；实际 Retry-After、健康度和配额继续由现有 governor 处理。
- 每个来源期限 15 秒，包含等待 admission；GET 429/5xx 最多 3 次，普通传输失败不重试。
- 重定向拒绝；流式响应最多 4 MiB，超限取消 body reader。缓存为 32 条、总量 8 MiB、5 分钟 TTL，以 projectId/URL/Accept 隔离。
- Provider payload、映射后的关系结构及集合上限通过验证后才进入缓存。HTTP 成功但 schema/身份/分页失败仍保存失败来源观察。
- Semantic Scholar 每页 1–100 条，offset 最大 9900；超出此产品边界需新的实施与合同评估。OpenAlex/Crossref 单次各最多 10000 个映射关系，超限失败，不截断成成功。
- IPC 捕获只返回摘要，历史每页最多 50 条，关系每页最多 100 条。主进程读取会核对完整的有界快照；尚未声称面向百万节点的索引性能。

四个声明式 IPC 方法：`captureScholarlyRelations`、`cancelScholarlyRelations`、`getScholarlyHistory`、`getScholarlyRelations`。生成的 preload 和共享类型由 `pnpm generate:ipc` 维护，没有兼容别名。

## 阅读器中的来源检查

X-ECO A2 在现有 `PaperReader` 操作栏添加「学术关系」，打开时才加载面板及读取历史。面板使用阅读器内独立滚动区域，不新增 shell 或路由。历史每页 20 条，关系每页 50 条；选中记录后历史折叠，仍可展开或翻页。

显示保存时的 DOI、文献版本、查询时间及各来源真实状态。来源详情保留字段是否报告、未映射数量、撤稿观察、获取时间、缓存、GET 回执、响应哈希和端点；关系展示方向、类型、原始 Provider 类型、字段及断言方。Semantic Scholar 后续页必须点击另存，沿用原记录的 limit 和新 requestId，超出 offset 9900 时明确禁用。

查询期间禁用新查询、来源选择、历史选择和分页，取消走主进程真实请求。丢失捕获回执可重试完整原请求；已保存的来源失败通过新请求重新查询。收到取消信号的请求不提供原请求重试。只读、归档、未关联或缺 DOI 时禁止新捕获，但可查看保存历史；文献版本改变后明确显示历史观察。项目或文献切换时重建面板状态，迟到读取和捕获回执不进入新范围。

## 验证记录

工作目录：`/Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc`。验证日志位于 `.artifacts/research-optimization/xeco-a1-*.log`。

已完成：`node --test --test-timeout=30000 --test-reporter=tap tests/unit/research-scholarly-relations.test.mjs tests/unit/literature-import.test.mjs tests/unit/research-review-search.test.mjs tests/unit/research-journal-compliance.test.mjs tests/unit/database-migrations.test.mjs`，141/141 通过。

最终 `node --test --test-timeout=30000 --test-reporter=tap tests/unit/research-scholarly-relations.test.mjs`，17/17 通过。新增 17 项关系回归覆盖来源方向、身份、缺少标识、schema 变化、分页、部分失败、429、超时、流式超限、配额、缓存隔离、验证后缓存、精确重放、版本改变、取消、关闭、迁移及实际 capability/IPC 合同。输入为隔离响应 fixture，不能代替真实科研数据的科学性验收。

`pnpm test:unit` 1313/1313 通过（最后新增的存储身份回归另以 17/17 focused 验证）；`pnpm harness:eval` 94/94、`node scripts/run-research-p0.mjs` 13/13 通过。最终存储校验后 `pnpm build`（包含 typecheck）、`node scripts/smoke-electron.mjs` 13/13 且零 renderer 错误、`pnpm check:ipc`、`pnpm check:renderer-chunks`（1134468 bytes / 6 eager files）及 `git diff --check` 通过。

A2 最终 `node --test --test-timeout=60000 --test-reporter=tap tests/renderer/scholarly-relations.test.mjs` 8/8 通过；相关串行回归 `node --test --test-concurrency=1 --test-timeout=60000 --test-reporter=tap tests/renderer/scholarly-relations.test.mjs tests/renderer/paper-reader.test.mjs tests/renderer/literature-review.test.mjs tests/renderer/artifact-production.test.mjs` 50/50 通过。测试运行真实 Electron、仓储、服务、governor 和严格 IPC，使用隔离 Provider 响应。

A2 `pnpm build`（包含 typecheck）、`node scripts/smoke-electron.mjs` 13/13 且零 renderer 错误、`pnpm check:ipc`、`pnpm check:renderer-chunks`（1134468 bytes / 6 eager files）通过。650px 浅色/暗色检查无横向溢出，键盘 focus-visible 轮廓可见；八个默认、hover、展开、终态裁切审计均 cut=0、hidden=0。终态测试等待原生 disclosure 的实际高度和透明度，截图确认完整来源详情可读。截图和审计保存于 `.artifacts/research-optimization/xeco-a2/`，日志为 `xeco-a2-*.log`。

状态：**Verified passing**（A1/A2 本地工程）。没有真实 API 科学性验收或外部发布。
