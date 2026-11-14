# 科研 RO-Crate 合同

导出固定 RO-Crate **1.2** 和 Roc profile **roc-research-1**。这是明确的稳定目标；不声称为最新规范。公开元数据、图生成及离线校验接入 `prepareExport` 和实际 ZIP。准备、生成、封存和保存流程统一见[导出合同](research-exports.md)；本文只定义公开元数据与逐资源再分发审查。

规范依据：[1.2 结构](https://www.researchobject.org/ro-crate/specification/1.2/structure.html)、[根数据实体](https://www.researchobject.org/ro-crate/specification/1.2/root-data-entity.html)、[profile](https://www.researchobject.org/ro-crate/specification/1.2/profiles.html)、[软件源码](https://www.researchobject.org/ro-crate/specification/1.2/workflows.html)、[validator 离线模式](https://rocrate-validator.readthedocs.io/en/stable/5_offline_mode/)。

## 输入与实体

公开输入必须明确提供名称、说明、发布日期、作者和许可。每个论文、数据、软件、结果、图稿或参考文献对象有自己的许可和交付方式；许可字段本身不授予再分发权。

- `bundled` 引用真实清单中的相对路径。
- `metadata_only` 保留公开定位及获取说明，不能携带文件路径；参考文献必须使用此方式。
- 软件对象必须提供公开 HTTPS URL 和版本；不从本机路径推断。
- 唯一论文对象为 `mainEntity`，必须有工件 ID、精确版本、记录时间及审核文件的人工批准绑定。科学批准不等于公开发布授权。
- 实验活动保留实际终态、输入/输出/软件关系、环境摘要及版本、包版本、参数和随机种子。未记录的 seed 明确显示未知，不能填成零。

公开字段拒绝私有路径、凭证赋值及包含用户信息或查询参数的 URL。该模块只接收专门的公开输入，不接收原始私有 sources、runtime 或 Provider 配置。

## 文件与生成顺序

规范 context 使用 `https://w3id.org/ro/crate/1.2/context` 的引用，并在同一 context 数组中声明 Roc 扩展命名空间。不得把官方 context 改为内嵌对象以绕开网络。

`ro-crate-profile.html` 是包内可读的 profile 说明，包含 `File`、`CreativeWork`、`Profile` 类型及固定版本。说明文件必须登记大小与 SHA-256，实际字节必须与模块固定的说明一致。软件源码文件同时包含 `File` 和 `SoftwareSourceCode` 类型。

先写 payload 和 profile，再生成 `ro-crate-metadata.json`，最后生成 `manifest.json`。manifest 封存 metadata 的实际字节；crate 引用 manifest，但不保存 manifest 的 checksum。metadata descriptor 不保存自己的 checksum。中文及空格路径按 URI 路径段编码，文件名与实际清单保持一一对应。

离线 Roc 校验拒绝错误版本、缺少作者/许可/批准、重复实体、NFC/大小写文件碰撞、悬空或不可达引用、清单/大小/哈希不符和 metadata-only 夹带文件。迭代遍历支持声明范围内的深层来源关系。真实字节校验复用 canonical-root、普通文件及 symlink 拒绝边界，并核对磁盘 metadata 与传入图一致；支持取消。

## 公开投影边界

`projectResearchPublicValue` 接收 JSON，生成严格的 `public_projection`：

- `originalSha256` 是原始 JSON 的 canonical serialization 摘要。
- `projectionSha256` 是公开 `value` 的 canonical serialization 摘要。
- `omittedFields` 使用 JSON Pointer 和原因记录被删去的 native 字段、凭证、私有 URL 或字段名。
- 原始对象保持不变；普通科学指标、单位、seed、版本和完整历史保持原值。含私有值的任意文本变为明确登记的缺失值，而不是伪造原文。

公开投影只证明其自身 JSON 完整性，不能凭原始哈希独立验证私有回执。对原始文件投影时还需要另存实际文件的字节哈希和大小；canonical JSON 哈希不能冒充磁盘字节哈希。只改变私有字段也会改变完整投影封存值，因此后续审批不能仅比较 `projectionSha256`。

parser 改变输入 JSON（包括丢弃保留属性）时直接拒绝。独立校验拒绝错误投影摘要、未声明的私有值、旧版 raw receipt 和缺少必填字段的数据。公开字符串的私有值识别由 crate 输入和投影模块共用。

公开投影用于实际 ZIP 的 sources、科学审核、figure manifest 和日志。日志及图稿 manifest 使用
`public_file_projection`，另存原磁盘文件 path/sha256/size；内层 projection 保存 canonical JSON 摘要和省略清单。
改写后的历史回执标为 `private_source_receipt` 并登记 verification_claim，不声称能由公开包重建私有回执。

## 原始资源与再分发审查合同

`research.export.inputs` / `research.getExportInputs` 只读 API 复用当前项目、已接受稿件、图稿审批、实验快照和科学审核校验。返回当前完整来源的 `sourceHash`、原文件相对路径、大小、SHA-256、用途及必须随包交付的原因；不会建立导出或修改审批。输入只含项目、稿件、图稿和模板选择，不需要伪造作者、许可或完整 prepare 请求。

每个实验和图稿的原始 input/output、导入模板文件均需独立选择；日志作为公开投影处理，不列入原件再分发选择。合同拒绝漏选、重复、外来资源、改变的大小或摘要、过期来源、未声明参考文献许可。程序文件必须显式登记为软件并提供公开 HTTPS URL 和版本，选中图稿的渲染文件必须登记为图稿。选中图稿及导入模板必须明确允许随包交付，否则拒绝该导出选择。受限数据、代码等保留 `metadata_only` 及获取说明，不推断许可。

`validateExportPublication` 用于 prepare、实际 ZIP 和发布/交付重验边界。

## 人工出版审查

已批准稿件的工件抽屉按需打开“审查公开科研导出”。项目处于 export、来源有效且可写时，
才可读取新选择、预览或提交；历史仍可只读查看。读取真实已批准图稿与就绪模板，不推断作者或许可。

通过 `getExportInputs` 捕获当前来源，逐原件填写对象类型、公开元数据、许可和交付决定。
必须交付的图稿与模板只能 bundled；软件提供 URL/版本，参考文献仅元数据。bundled 保持原字节，
识别到私有文本时拒绝交付；metadata_only 不复制原件。不可达模板文件放在 provenance/template，
留在编译树之外。

预览使用严格 schema 并重新捕获 sourceHash；来源漂移要求重新读取和审查。回执展示全部公开字段、
许可、获取说明、原件 SHA-256 和交付决定。编辑撤销预览并更换 requestId，丢失回执保留原请求精确重试。
锁定、取消、迟到响应与历史读取遵循[工件检查器](research-artifact-inspector.md)。界面不执行外部公开发布。
