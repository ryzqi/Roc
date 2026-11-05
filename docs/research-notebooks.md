# Notebook 导入与执行合同

`parseResearchNotebook` 只读取字节，不启动 Python、Jupyter 或 shell，也不运行源码、Markdown、HTML、JavaScript、SVG 或附件。

只支持 nbformat 4.5，要求唯一的 1–64 字符 cell ID（字母、数字、`-`、`_`）。旧版本和未实现的未来版本拒绝，不转换或补造 ID。结构、元数据、stream/display/execute-result/error 和 MIME 数据规则来自 [nbformat 官方格式说明](https://nbformat.readthedocs.io/en/latest/format_description.html) 和 [4.5 JSON Schema](https://github.com/jupyter/nbformat/blob/main/nbformat/v4/nbformat.v4.5.schema.json)，2026-11-06 核对。产品固定 minor=5；官方 schema 的未来 minor 容纳能力不代表产品支持。

解析前限制 8 MiB、32 层和 100000 个 JSON 节点；最多 500 cells，每个源代码 256 KiB、100 个输出，每个输出序列化 2 MiB、100 个核查标记。超过任何限额直接失败，不丢弃超限 cells 或输出。预览源码和文本输出各最多 8000 字符，同时返回原始字符数和完整哈希。

解析结果保留原 cell 顺序、源码的字符串/数组表示、metadata、执行计数、输出和附件。原始字节 SHA-256、cell 内容 SHA-256、规范源码文本 SHA-256、输出和附件 SHA-256 分别记录；执行计数不是实际运行证明。项目接入需要保留原始字节，单独的规范源码哈希不能替代原文件身份。

预览只提供源码和 literal text；Markdown/raw 内容也作为文本。rich MIME 仅列类型、哈希和核查标记，不提供可运行文档、资源 URL 或原始 MIME data。所有输出固定为 `untrusted`，忽略 `metadata.trusted` 的信任声明。消费界面必须使用文本节点，不得将文本送入 `innerHTML`、脚本或 iframe。

魔法命令、shell/subprocess、路径字面量和扩展会保留行号核查标记；它们是静态线索，不能证明全部运行行为或替代声明输入和实际隔离。不存在 Python/Jupyter 兼容执行的默认分支，也不把已存在输出纳入科学证据。

A1 验证（2026-11-06，项目根目录）：`node --test tests/unit/research-notebook-parser.test.mjs` 6/6；`pnpm typecheck`、`pnpm build` 均 exit 0。初轮 cell 哈希回归发现 Zod 重建对象改变字段顺序；修复为校验后保留原始 decoded JSON，完整原字节仍作为最高来源身份。日志 `.artifacts/research-optimization/xnb-a1-{unit-final,type,build}.log`。本提交仅验证解析合同，不代表项目导入/UI/执行已完成。

## 项目冻结导入（A2）

`research.notebooks.preview` 从项目工作目录完整读取 `.ipynb`；`import` 要求主进程绑定的用户窗口身份和预览文件的 SHA-256。只接受项目内普通文件，拒绝符号链接、越界路径、内部缓存路径和超限文件。导入原字节作为 BLOB 保存在研究库，附带项目、原相对路径、工作目录、用户窗口、时间和不可变回执哈希。未执行任何 cell，也不创建实验/证据工件。

相同请求和用户的重放返回原记录，源码移动/删除或归档不触发重新导入。新请求要求项目可写；变化的原文件哈希、请求冲突、跨项目读取或回执损坏直接失败。`get` 在返回静态预览前重验原字节和回执身份。`list` 显式分页，每页至多 100 条回执，不传递完整字节或 rich MIME data。旧版本仅通过原始哈希的明确引用读取，不推断“最新”身份。

A2 验证（2026-11-06，项目根目录）：`node --test tests/unit/research-notebook-parser.test.mjs tests/unit/research-notebook-import.test.mjs` 12/12；`pnpm test:unit` 1193/1193；`pnpm typecheck`、`pnpm build`、`pnpm check:ipc` 通过；`node scripts/run-research-p0.mjs` 13/13、`node scripts/harness-eval/run.mjs` 94/94；`node scripts/smoke-electron.mjs` 13/13，零 renderer errors；`pnpm check:renderer-chunks` 1132907 bytes / 6 files。日志 `.artifacts/research-optimization/xnb-a2-*.log`。本部分不包含预览界面或受控 cell 执行。

## 文件预览（A3）

现有文件树打开 `.ipynb` 时按需加载 Notebook 预览。当前文件与导入版本分别读取；选中确切回执后才读取冻结源码。导入按钮绑定正在预览的文件 SHA，显示真实 pending/error；归档或不匹配的项目不可导入。更换项目/工作目录/文件丢弃旧读取状态。导入历史按 20 条分页，不自动把其他版本当作当前文件。

源码、Markdown、输出与附件类型均通过 React 文本节点显示。已有执行计数和输出明确标注为原始未受信记录；不会创建 iframe、执行脚本或加载附件。文件和 cell/source/output/attachment 哈希可展开核对。原文件变化或缺失时仍可明确选择原导入快照。

预览浮层沿用现有控件、焦点和 Escape 行为，挂载到 `document.body`，避免文件侧栏滚动祖先裁切投影。真实 Electron 初轮裁切审计发现底部 28.8px；修复后的明暗主题均 `cut=0, hidden=0`。480px 组件视口下无页面横向溢出，代码局部滚动、来源哈希换行；生产明暗截图和窄窗焦点截图已视觉核对。

A3 验证（2026-11-06，项目根目录）：`pnpm build`（含 typecheck）；`node --test tests/renderer/notebook-preview.test.mjs` 6/6；`node --test tests/unit/renderer-paths.test.mjs` 14/14；`node --test tests/integration/research-notebook-electron.test.mjs` 1/1，真实文件树/键盘/preload/main/磁盘重启，包含普通文本预览与编辑回归，零恶意资源请求/代码执行；`node --test tests/renderer/file-tree-virtualization.test.mjs` 1/1；`pnpm check:ipc`、`pnpm check:renderer-chunks` 通过（1133919 bytes / 6 files）；`node scripts/smoke-electron.mjs` 13/13，零 renderer errors。证据 `.artifacts/research-optimization/xnb-a3-*.log`、`xnb-a3-{ui,electron}/`。

较广的 `ROC_SMOKE_TARGET=dist node scripts/verify-p3-workspace.mjs` 在原有外部文件刷新性能闸门失败：474ms，目标 ≤200ms；后续闸门未运行。本部分未改文件监听或该性能要求，不宣称 P3 全闸门通过。文件树首次 End 键等待超时，原代码及测试不变的单独重跑通过；并发原因未确认。受控 cell 执行仍是下一部分。

## 受控 Python cell 子集（A4A）

`notebookPythonSource` 只为明确声明 Python 的冻结 nbformat 4.5 生成执行源码。kernelspec 若提供，必须是 python3/Python；拒绝 raw cell 和无 code 的 Notebook。Markdown 不执行，已有输出不进入运行结果。代码按原 cell 顺序在共享的独立 `__main__` 命名空间执行，完整源码不使用截断预览。每个文件名包含原 Notebook SHA 和 cell ID，错误保留原 cell 行号。

固定 subsetVersion=1：真实选中解释器先对全部 cell 做 AST 校验及 exec-mode 编译，全部成功后才执行第一 cell；不实现交互式表达式 display、跨 cell future 状态、IPython magics、shell cell、top-level await 或 Jupyter 扩展，拒绝这些语义。注释、字符串中的 `%`/`!`、Unicode 和模运算不改写。导入限定为 roc_experiment、math、statistics、csv、json、pathlib、random、hashlib、datetime、decimal、fractions、itertools、functools、collections、typing、numpy、scipy、pandas、matplotlib；拒绝相对导入、动态执行入口和 dunder 属性反射。该 AST 合同不是安全沙箱，实际环境、文件/网络隔离和资源治理仍必须由 PR08 执行链提供。

生成内容绑定完整原字节和大小、不可变导入回执、cell ID/顺序/cellHash/sourceHash、executorHash 和最终 sourceHash。采用 ASCII base64 封装 JSON，未受信源码不参与生成脚本的引号语法。运行时负结果保留此前实际 stdout，并在失败 cell 停止。A4A 本身不注册启动接口、不写用户工作目录，也不执行产品请求。

A4A 验证（2026-11-06，项目根目录）：`node --test tests/unit/research-notebook-python-source.test.mjs tests/unit/research-notebook-parser.test.mjs tests/unit/research-notebook-import.test.mjs` 18/18，含本机 CPython 3.14 的实际执行；`pnpm typecheck` 和 `pnpm build` exit 0。完整源码超过 8000 字符、共享定义、先全编译、原 cell 行号、不支持语义零提前执行、负结果与哈希篡改均有断言。初轮测试因临时目录无法解析 external Zod 在加载阶段失败；测试打包依赖后通过，产品合同未变。日志 `.artifacts/research-optimization/xnb-a4a-{focused,type,build}.log`。

## 冻结 Notebook 的真实执行（A4B）

Python 启动合同要求显式 `source`：脚本为 `{kind:'file',path:'analysis.py'}`，Notebook 为 `{kind:'notebook',notebookId,expectedHash,subsetVersion:1}`。`expectedHash` 是用户导入回执的 `snapshotHash`；项目由当前调用绑定。旧 Python `sourcePath` 字段、未知子集版本、其他项目和不完整身份直接拒绝。

Notebook 使用 PR08 用户选定的 CPython 环境、预览哈希、固定启动参数、随机种子、Seatbelt、资源限额、取消及进程树清理。冻结输入仅有 `roc-notebook/original.ipynb` 原字节、`roc-notebook/receipt.json` 完整回执和 `roc-notebook/run.py` 子集源码，均为 0400，只写实验存储。原工作目录 Notebook 修改、移动或删除不改变已经引用的导入版本。声明输入和环境锁文件不能占用这些路径；其他输入仍核验当前工作目录字节。

`inputHash` 绑定显式来源、全部冻结文件、参数、seed 和实际环境。重放与发布重新读取研究库原字节和回执并生成三份输入核对，篡改脚本后即使重算磁盘/数据库文件哈希也不能通过。成功计算生成实验工件后仍需人工审核；失败、timeout、cancel 和中断保留实际日志与资源回执。生产检查器显示确切 Notebook ID 和保存请求，不把已有 Notebook 输出当作实际结果。

A4B 验证（2026-11-06，项目根目录）：

- `node --test --test-name-pattern='Notebook' tests/integration/research-python-experiments.test.mjs` 5/5；新增 owned 重放/发布断言后，`node --test --test-name-pattern='actual Notebook execution freezes' tests/integration/research-python-experiments.test.mjs` 1/1。
- `node --test --test-concurrency=1 --test-name-pattern='^(?!.*Notebook)' tests/integration/research-python-experiments.test.mjs tests/integration/research-python-process.test.mjs tests/integration/research-python-selection.test.mjs` 实际执行了 33 项，32 项通过；唯一失败为已有迁移测试仍期待 DB42，Notebook 导入已采用 DB43。修正明确版本后，`node --test --test-name-pattern='DB41 upgrade' tests/integration/research-python-selection.test.mjs` 1/1；不宣称原命令 exit 0。
- `pnpm test:unit` 1199/1199；`node --test tests/renderer/artifact-production.test.mjs` 9/9；`pnpm typecheck`、`pnpm build`、`pnpm check:ipc` 通过。
- `node scripts/run-research-p0.mjs` 13/13；`node scripts/harness-eval/run.mjs` 94/94；`node scripts/smoke-electron.mjs` 13/13，零 renderer errors；`pnpm check:renderer-chunks` 1133982 bytes / 6 files。

真实用例覆盖超过 8000 字符的 cell、全部先编译、原 cell 行号、负结果、冻结 0400 输入、越界写入 PermissionError、超时/取消、错误引用零 compute、host rehash 拒绝和磁盘重启零 dispatch。参数测试初轮在 `details.open=true`、完整 pre 存在但原生 `::details-content` 尚未显示时读取 innerText；保留键盘与可见内容断言，等待实际显示和原生动画结束后通过，未改产品动效。证据 `.artifacts/research-optimization/xnb-a4b-*.log`。本部分完成 Notebook 执行；指标比较与假设关联属于后续 X-EXP。
