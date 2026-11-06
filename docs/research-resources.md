# 科研资源与 DataCite 元数据观察

X-ECO A3A 在现有科研插件中新增 ResearchResource 元数据观察。数据集和软件 DOI 保存为独立资源，使用已有检索传输、主机治理和缓存；不会导入论文、下载内容或改变科研审批。论文及实验的显式版本关联属于后续 A3B，资源 UI 属于后续独立增量。

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

状态：**Verified passing**（A3A 本地元数据核心）。A3B 关联与 UI 尚未完成；没有真实科研数据科学性验收。
