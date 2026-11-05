# Notebook 静态导入合同

X-NB A1 定义解析与预览合同，项目导入、界面和执行接入随后完成。`parseResearchNotebook` 只读取字节，不启动 Python、Jupyter 或 shell，也不运行源码、Markdown、HTML、JavaScript、SVG 或附件。

只支持 nbformat 4.5，要求唯一的 1–64 字符 cell ID（字母、数字、`-`、`_`）。旧版本和未实现的未来版本拒绝，不转换或补造 ID。结构、元数据、stream/display/execute-result/error 和 MIME 数据规则来自 [nbformat 官方格式说明](https://nbformat.readthedocs.io/en/latest/format_description.html) 和 [4.5 JSON Schema](https://github.com/jupyter/nbformat/blob/main/nbformat/v4/nbformat.v4.5.schema.json)，2026-11-06 核对。产品固定 minor=5；官方 schema 的未来 minor 容纳能力不代表产品支持。

解析前限制 8 MiB、32 层和 100000 个 JSON 节点；最多 500 cells，每个源代码 256 KiB、100 个输出，每个输出序列化 2 MiB、100 个核查标记。超过任何限额直接失败，不丢弃超限 cells 或输出。预览源码和文本输出各最多 8000 字符，同时返回原始字符数和完整哈希。

解析结果保留原 cell 顺序、源码的字符串/数组表示、metadata、执行计数、输出和附件。原始字节 SHA-256、cell 内容 SHA-256、规范源码文本 SHA-256、输出和附件 SHA-256 分别记录；执行计数不是实际运行证明。项目接入需要保留原始字节，单独的规范源码哈希不能替代原文件身份。

预览只提供源码和 literal text；Markdown/raw 内容也作为文本。rich MIME 仅列类型、哈希和核查标记，不提供可运行文档、资源 URL 或原始 MIME data。所有输出固定为 `untrusted`，忽略 `metadata.trusted` 的信任声明。消费界面必须使用文本节点，不得将文本送入 `innerHTML`、脚本或 iframe。

魔法命令、shell/subprocess、路径字面量和扩展会保留行号核查标记；它们是静态线索，不能证明全部运行行为或替代声明输入和实际隔离。不存在 Python/Jupyter 兼容执行的默认分支，也不把已存在输出纳入科学证据。

A1 验证（2026-11-06，项目根目录）：`node --test tests/unit/research-notebook-parser.test.mjs` 6/6；`pnpm typecheck`、`pnpm build` 均 exit 0。初轮 cell 哈希回归发现 Zod 重建对象改变字段顺序；修复为校验后保留原始 decoded JSON，完整原字节仍作为最高来源身份。日志 `.artifacts/research-optimization/xnb-a1-{unit-final,type,build}.log`。本提交仅验证解析合同，不代表项目导入/UI/执行已完成。
