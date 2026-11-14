# Notebook 导入与执行合同

`parseResearchNotebook` 只读取字节，不启动 Python、Jupyter 或 shell，也不运行源码、Markdown、HTML、JavaScript、SVG 或附件。

只支持 nbformat 4.5，要求唯一的 1–64 字符 cell ID（字母、数字、`-`、`_`）。旧版本和未实现的未来版本拒绝，不转换或补造 ID。结构、元数据、stream/display/execute-result/error 和 MIME 数据规则来自 [nbformat 官方格式说明](https://nbformat.readthedocs.io/en/latest/format_description.html) 和 [4.5 JSON Schema](https://github.com/jupyter/nbformat/blob/main/nbformat/v4/nbformat.v4.5.schema.json)，2026-11-06 核对。产品固定 minor=5；官方 schema 的未来 minor 容纳能力不代表产品支持。

解析前限制 8 MiB、32 层和 100000 个 JSON 节点；最多 500 cells，每个源代码 256 KiB、100 个输出，每个输出序列化 2 MiB、100 个核查标记。超过任何限额直接失败，不丢弃超限 cells 或输出。预览源码和文本输出各最多 8000 字符，同时返回原始字符数和完整哈希。

解析结果保留原 cell 顺序、源码的字符串/数组表示、metadata、执行计数、输出和附件。原始字节 SHA-256、cell 内容 SHA-256、规范源码文本 SHA-256、输出和附件 SHA-256 分别记录；执行计数不是实际运行证明。项目接入需要保留原始字节，单独的规范源码哈希不能替代原文件身份。

预览只提供源码和 literal text；Markdown/raw 内容也作为文本。rich MIME 仅列类型、哈希和核查标记，不提供可运行文档、资源 URL 或原始 MIME data。所有输出固定为 `untrusted`，忽略 `metadata.trusted` 的信任声明。消费界面必须使用文本节点，不得将文本送入 `innerHTML`、脚本或 iframe。

魔法命令、shell/subprocess、路径字面量和扩展会保留行号核查标记；它们是静态线索，不能证明全部运行行为或替代声明输入和实际隔离。不存在 Python/Jupyter 兼容执行的默认分支，也不把已存在输出纳入科学证据。

## 项目冻结导入
`research.notebooks.preview` 从项目工作目录完整读取 `.ipynb`；`import` 要求主进程绑定的用户窗口身份和预览文件的 SHA-256。只接受项目内普通文件，拒绝符号链接、越界路径、内部缓存路径和超限文件。导入原字节作为 BLOB 保存在研究库，附带项目、原相对路径、工作目录、用户窗口、时间和不可变回执哈希。未执行任何 cell，也不创建实验/证据工件。

相同请求和用户的重放返回原记录，源码移动/删除或归档不触发重新导入。新请求要求项目可写；变化的原文件哈希、请求冲突、跨项目读取或回执损坏直接失败。`get` 在返回静态预览前重验原字节和回执身份。`list` 显式分页，每页至多 100 条回执，不传递完整字节或 rich MIME data。旧版本仅通过原始哈希的明确引用读取，不推断“最新”身份。

## 文件预览
现有文件树打开 `.ipynb` 时按需加载 Notebook 预览。当前文件与导入版本分别读取；选中确切回执后才读取冻结源码。导入按钮绑定正在预览的文件 SHA，显示真实 pending/error；归档或不匹配的项目不可导入。更换项目/工作目录/文件丢弃旧读取状态。导入历史按 20 条分页，不自动把其他版本当作当前文件。

源码、Markdown、输出与附件类型均通过 React 文本节点显示。已有执行计数和输出明确标注为原始未受信记录；不会创建 iframe、执行脚本或加载附件。文件和 cell/source/output/attachment 哈希可展开核对。原文件变化或缺失时仍可明确选择原导入快照。

预览浮层挂载到 `document.body`，避免文件侧栏滚动祖先裁切，沿用焦点和 Escape 行为。代码局部滚动、来源哈希换行，支持明暗主题与窄窗；验证入口见[验证说明](verification.md)。

## 受控 Python cell 子集
`notebookPythonSource` 只为明确声明 Python 的冻结 nbformat 4.5 生成执行源码。kernelspec 若提供，必须是 python3/Python；拒绝 raw cell 和无 code 的 Notebook。Markdown 不执行，已有输出不进入运行结果。代码按原 cell 顺序在共享的独立 `__main__` 命名空间执行，完整源码不使用截断预览。每个文件名包含原 Notebook SHA 和 cell ID，错误保留原 cell 行号。

固定 subsetVersion=1：真实选中解释器先对全部 cell 做 AST 校验及 exec-mode 编译，全部成功后才执行第一 cell；不实现交互式表达式 display、跨 cell future 状态、IPython magics、shell cell、top-level await 或 Jupyter 扩展，拒绝这些语义。注释、字符串中的 `%`/`!`、Unicode 和模运算不改写。导入限定为 roc_experiment、math、statistics、csv、json、pathlib、random、hashlib、datetime、decimal、fractions、itertools、functools、collections、typing、numpy、scipy、pandas、matplotlib；拒绝相对导入、动态执行入口和 dunder 属性反射。该 AST 合同不是安全沙箱，实际隔离仍由[Python 执行链](research-python-environment.md)和[资源治理](research-execution-resources.md)提供。

生成内容绑定完整原字节和大小、不可变导入回执、cell ID/顺序/cellHash/sourceHash、executorHash 和最终 sourceHash。采用 ASCII base64 封装 JSON，未受信源码不参与生成脚本的引号语法。运行时负结果保留此前实际 stdout，并在失败 cell 停止。源码生成与下述实验启动分别执行，不写用户工作目录。

## 冻结 Notebook 的真实执行
Python 启动合同要求显式 `source`：脚本为 `{kind:'file',path:'analysis.py'}`，Notebook 为 `{kind:'notebook',notebookId,expectedHash,subsetVersion:1}`。`expectedHash` 是用户导入回执的 `snapshotHash`；项目由当前调用绑定。旧 Python `sourcePath` 字段、未知子集版本、其他项目和不完整身份直接拒绝。

Notebook 使用用户选定的 CPython 环境、预览哈希、固定启动参数、随机种子、Seatbelt、资源限额、取消及进程树清理。冻结输入仅有 `roc-notebook/original.ipynb` 原字节、`roc-notebook/receipt.json` 完整回执和 `roc-notebook/run.py` 子集源码，均为 0400，只写实验存储。原工作目录 Notebook 修改、移动或删除不改变已经引用的导入版本。声明输入和环境锁文件不能占用这些路径；其他输入仍核验当前工作目录字节。

`inputHash` 绑定显式来源、全部冻结文件、参数、seed 和实际环境。重放与发布重新读取研究库原字节和回执并生成三份输入核对，篡改脚本后即使重算磁盘/数据库文件哈希也不能通过。成功计算生成实验工件后仍需人工审核；失败、timeout、cancel 和中断保留实际日志与资源回执。生产检查器显示确切 Notebook ID 和保存请求，不把已有 Notebook 输出当作实际结果。
