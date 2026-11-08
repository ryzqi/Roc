# 科研 RO-Crate 合同

导出固定 RO-Crate **1.2** 和 Roc profile **roc-research-1**。这是明确的稳定目标；不声称为最新规范。公开元数据、图生成及离线校验已接入 `prepareExport` 和实际 ZIP。prepare 必须提交逐资源出版审查；既有工件抽屉提供作者、许可与交付方式编辑。

规范依据：[1.2 结构](https://www.researchobject.org/ro-crate/specification/1.2/structure.html)、[根数据实体](https://www.researchobject.org/ro-crate/specification/1.2/root-data-entity.html)、[profile](https://www.researchobject.org/ro-crate/specification/1.2/profiles.html)、[软件源码](https://www.researchobject.org/ro-crate/specification/1.2/workflows.html)、[validator 离线模式](https://rocrate-validator.readthedocs.io/en/stable/5_offline_mode/)。

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

## 公开投影边界

`projectResearchPublicValue` 接收 JSON，生成严格的 `public_projection`：

- `originalSha256` 是原始 JSON 的 canonical serialization 摘要。
- `projectionSha256` 是公开 `value` 的 canonical serialization 摘要。
- `omittedFields` 使用 JSON Pointer 和原因记录被删去的 native 字段、凭证、私有 URL 或字段名。
- 原始对象保持不变；普通科学指标、单位、seed、unknown cost、版本和完整历史保持原值。含私有值的任意文本变为明确登记的缺失值，而不是伪造原文。

公开投影只证明其自身 JSON 完整性，不能凭原始哈希独立验证私有回执。对原始文件投影时还需要另存实际文件的字节哈希和大小；canonical JSON 哈希不能冒充磁盘字节哈希。只改变私有字段也会改变完整投影封存值，因此后续审批不能仅比较 `projectionSha256`。

parser 改变输入 JSON（包括丢弃保留属性）时直接拒绝。独立校验拒绝错误投影摘要、未声明的私有值、旧版 raw receipt 和缺少必填字段的数据。公开字符串的私有值识别由 crate 输入和投影模块共用。

公开投影应用于实际 ZIP 的 sources、科学审核、figure manifest 和日志。

## 原始资源与再分发审查合同

`research.export.inputs` / `research.getExportInputs` 只读 API 复用当前项目、已接受稿件、图稿审批、实验快照和科学审核校验。返回当前完整来源的 `sourceHash`、原文件相对路径、大小、SHA-256、用途及必须随包交付的原因；不会建立导出或修改审批。输入只含项目、稿件、图稿和模板选择，不需要伪造作者、许可或完整 prepare 请求。

每个实验和图稿的原始 input/output、导入模板文件均需独立选择；日志作为公开投影处理，不列入原件再分发选择。合同拒绝漏选、重复、外来资源、改变的大小或摘要、过期来源、未声明参考文献许可。程序文件必须显式登记为软件并提供公开 HTTPS URL 和版本，选中图稿的渲染文件必须登记为图稿。选中图稿及导入模板必须明确允许随包交付，否则拒绝该导出选择。受限数据、代码等保留 `metadata_only` 及获取说明，不推断许可。

`validateExportPublication` 用于 prepare、实际 ZIP 和发布/交付重验边界。

## 实际 ZIP 与公开封存

manifest 采用严格版本 3；旧 manifest 和缺少 publicationReview 的 prepare 请求拒绝。来源 capture、execute、publish 和 write 均验证审查 sourceHash、资源身份、交付方式及许可元数据。完全相同请求重放返回已保存记录，不重新执行或新增事件；归档项目拒绝操作。

明确 bundled 的原件保持原字节、大小和哈希，识别到的私有文本拒绝交付。metadata_only 不复制原件，crate 仅保留许可及获取说明。图稿渲染文件与导入模板必须 bundled；不可达模板文件放在 provenance/template，留在编译树之外。

运行日志和图稿 manifest 使用 public_file_projection：originalFile 保存原磁盘字节的 path/sha256/size，内层 projection 分别保存原 JSON canonical 摘要、公开值摘要及 omission。来源、编译日志和科研审核使用 public_projection。改写后的 stored_receipt/redacted_receipt 标记改为 private_source_receipt，并登记 verification_claim；不宣称可由公开包重建私有回执。

生成顺序为 payload、固定 profile、真实 RO-Crate、manifest3、公开包校验、ZIP。crate 从实际资源清单和已批准工件派生，使用真实环境、参数、seed、内容与工件版本。manifest 封存 crate 字节；crate 不封存自身或 manifest 哈希。准备完成、历史 inspect 及交付时校验全部文件、公开投影、引用闭包与真实 ZIP 摘要；发布和交付额外重验当前科学审批。

## 人工出版审查

已批准稿件的工件抽屉提供懒加载的“审查公开科研导出”。当前项目处于 export 阶段、工件来源仍有效且客户端可写时，才能读取新出版选择、预览或提交；只读和归档状态仍可查看保存历史。界面读取实际已批准图稿和就绪模板，不推断作者、发布日期或再分发许可。

选择后通过 `getExportInputs` 捕获来源。每个原件明确填写科研对象类型、公开元数据、许可及随包交付或仅元数据决定；必须随包交付的图稿和模板禁用仅元数据。软件须提供 URL 与版本；参考文献只交付元数据，并填写许可和获取说明。

预览使用共享严格 schema，再重新捕获来源核对 sourceHash；来源漂移要求放弃编辑、重新读取和审查。预览及保存回执展示全部解析后的字段、许可说明、获取说明、原件 SHA-256 和交付决定；RO-Crate 版本单独标明。编辑会使预览失效并产生新 requestId。提交回执丢失时，保留原预览及 requestId，重新提交同一请求可查询原记录。

未完成审查和待定操作锁定抽屉关闭、刷新及其他编辑入口。权限变化保留已捕获草稿，并允许明确放弃；取消生成在只读状态禁用，等待后端取消终态期间锁定历史导航。生成状态、错误、取消及历史来自真实保存记录，界面不推断 PDF 成功，也不执行外部公开发布。
