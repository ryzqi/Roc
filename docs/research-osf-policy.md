# OSF 集成政策决定

工作项：X-ECO / §21.1 OSF。决定日期：2026-11-06。范围：核对官方政策并决定是否立项 Projects 写入同步。

## 已核对的官方时间表

| 日期 | 官方变化 | Roc 的实施含义 |
| --- | --- | --- |
| 2026-08-11 | COS 公告及支持文档发布 | 此为公告日期，不是 API 写入停用日期 |
| 2026-11-16 | 停止创建 Projects、components 和直接从 Project 创建注册 | 不建立依赖这些目的地的同步流程 |
| 2027-02-19 | Projects 转为只读，Project 写入/更新流程退役 | 不建立新的 Project 文件上传或持续写同步 |

既有公开 Projects 的读取、URL 和 DOI 保持可用；独立 OSF Registries 与 Preprints 工作流继续。公开 Projects 的可访问性不能推导为 Projects 写入服务继续；也不能将独立注册服务等同于从 Projects 创建注册。

来源于 2026-11-06 读取：[OSF Projects API Impact](https://help.osf.io/article/744-osf-projects-api-impact)（页面标注 2026-08-11 更新）及 [COS OSF Changes](https://www.cos.io/osf-changes)。API Impact 页关于个别剩余管理操作存在例外，不能从「只读」推导所有 HTTP 方法一律停用；本决定仅涉及新建、上传和持续写同步。

## 决定与后续边界

不立项 OSF Projects 写入同步。没有新增连接器、后台目的地、凭据配置或远端操作。未来可单独评估公开内容只读导入或独立预注册；当前决定不启动这两项，也不授权真实账户写入。Zenodo 审核式发布按 §21.2 独立实施。

## 验收

状态：`Verified passing`，仅覆盖政策核对和立项决定。官方来源读回、两个时间点与服务边界核对、文档空白检查通过。来源副本为 `/tmp/roc-osf-api-impact.md` 和 `/tmp/roc-osf-changes.md`；验证命令在仓库根目录：`git diff --cached --check`。没有宣称真实 OSF API 试验或新增导入/注册能力。
