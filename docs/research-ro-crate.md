# 科研 RO-Crate 合同

PR10 A1 固定 RO-Crate **1.2** 和 Roc profile **roc-research-1**。这是明确的稳定目标；不声称为最新规范。A1 提供公开元数据、图生成及离线校验模块，尚未接入 `prepareExport`、实际 ZIP 或导出 UI。既有导出包的公开隐私整改、资源再分发选择和 LaTeX 重编译属于后续 A2/A3。

## 输入与实体

公开输入必须明确提供名称、说明、发布日期、作者和许可。每个论文、数据、软件、结果、图稿或参考文献对象有自己的许可和交付方式；许可字段本身不授予再分发权。

- `bundled` 引用真实清单中的相对路径。
- `metadata_only` 保留公开定位及获取说明，不能携带文件路径；参考文献必须使用此方式。
- 软件对象必须提供公开 HTTPS URL 和版本；不从本机路径推断。
- 唯一论文对象为 `mainEntity`，必须有工件 ID、精确版本、记录时间及审核文件的人工批准绑定。科学批准不等于公开发布授权。
- 实验活动保留实际终态、输入/输出/软件关系、环境摘要及版本、包版本、参数和随机种子。未记录的 seed 和未知费用明确显示未知，不能填成零。

公开字段拒绝私有路径、凭证赋值及包含用户信息或查询参数的 URL。该模块只接收专门的公开输入，不接收原始私有 sources、runtime 或 Provider 配置。

## 文件与生成顺序

规范 context 使用 `https://w3id.org/ro/crate/1.2/context` 的引用，并在同一 context 数组中声明 Roc 扩展命名空间。不得把官方 context 改为内嵌对象以绕开网络。

`ro-crate-profile.html` 是包内可读的 profile 说明，包含 `File`、`CreativeWork`、`Profile` 类型及固定版本。说明文件必须登记大小与 SHA-256，实际字节必须与模块固定的说明一致。软件源码文件同时包含 `File` 和 `SoftwareSourceCode` 类型。

先写 payload 和 profile，再生成 `ro-crate-metadata.json`，最后生成 `manifest.json`。manifest 封存 metadata 的实际字节；crate 引用 manifest，但不保存 manifest 的 checksum。metadata descriptor 不保存自己的 checksum。中文及空格路径按 URI 路径段编码，文件名与实际清单保持一一对应。

离线 Roc 校验拒绝错误版本、缺少作者/许可/批准、重复实体、NFC/大小写文件碰撞、悬空或不可达引用、清单/大小/哈希不符和 metadata-only 夹带文件。迭代遍历支持声明范围内的深层来源关系。真实字节校验复用 canonical-root、普通文件及 symlink 拒绝边界，并核对磁盘 metadata 与传入图一致；支持取消。

## A1 验证

工作目录为仓库根目录。未修改全局 Python 或缓存配置；独立 validator 位于任务临时 venv，版本固定 `roc-validator==0.13.1`、CPython 3.14.7。

```bash
pnpm typecheck
node --test tests/unit/research-ro-crate.test.mjs \
  tests/unit/research-export-body-gate.test.mjs \
  tests/unit/research-semantic-publication.test.mjs \
  tests/unit/research-toolchain-versions.test.mjs

/tmp/roc-pr10-validator-0131/bin/rocrate-validator validate \
  --offline --cache-path /tmp/roc-pr10-validator-cache \
  --profile-identifier ro-crate-1.2 --no-auto-profile \
  --output-format json \
  --output-file .artifacts/research-optimization/pr10-a1-validator-report-software.json \
  --no-paging /private/var/folders/p8/s1717bsd4cz80g353254g8vc0000gn/T/roc-pr10-a1-software-YWXtOD
```

独立标准校验：30/30 required requirements、63 个 checks 通过、0 失败。另 3 个 checks 为离线可达性或 detached-package 不适用，报告中明确列出；未设置自定义 skip 或降低严重级别。离线通过不证明外部资源可下载。

工程 fixture 明确为合成数据。metadata SHA-256：
`bfe2a97c0f950650e01218fba5c074b0317c7426ce6a59cdddd2c9dca39eac1a`。
报告、fixture 路径与日志保存在 `.artifacts/research-optimization/pr10-a1-*`；不代表独立科学验收。

规范依据：[1.2 结构](https://www.researchobject.org/ro-crate/specification/1.2/structure.html)、[root 合同](https://www.researchobject.org/ro-crate/specification/1.2/root-data-entity.html)、[profile 合同](https://www.researchobject.org/ro-crate/specification/1.2/profiles.html)、[软件源码](https://www.researchobject.org/ro-crate/specification/1.2/workflows.html)、[validator 离线模式](https://rocrate-validator.readthedocs.io/en/stable/5_offline_mode/)。
