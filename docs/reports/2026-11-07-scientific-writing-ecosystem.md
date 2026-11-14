# 写作生态选型与实施回顾（2026-11-07）

历史基线为 `27d26daf01f96bc7c678e3fc999692da508f9d3d`。本文保留当时的选型依据、上游目录和验收摘要；现行接口由下面的专题维护。2026-11-14 文档同步没有重新调研、编译或运行这些用例，历史计数不代表当前验收。

## 证据范围

调研目录固定于 [awesome-scientific-writing](https://github.com/writing-resources/awesome-scientific-writing/blob/f4a041f9b029662debe237ba1098fe793070ccfe/README.md) 的 `f4a041f9b029662debe237ba1098fe793070ccfe`（2026-09-15，CC0），覆盖 66 个工具、插件、模板、教程和列表条目，未递归审计其他 awesome 列表。初次抓取取得 50 个 README/元数据记录，随后补读迁移项目和官网；50 不等于完成代码审计的项目数。

优先候选结合上游文档、许可与 Roc 调用链检查，citecheck 的匹配/网络/状态逻辑读得更深。两篇 DevGenius 教程仅取得公开节选；docutils 官网受限时补读镜像 README/COPYING。移动分支和网页仅代表调研日观察，许可列不能代替锁定分发产物及传递资源的审查。

## 保留的取舍

优先补互操作、检查一致性与交付，保留 CodeMirror、单壳、BibTeX/CSL 编解码、Vega 定量图稿、实验账本和 Typst/Tectonic 分工。完整编辑器、IDE 或出版器会连带改变文稿来源、输入、保存与执行语义，当时没有足以支持整体替换的收益证据。

citecheck 的 DOI 存在性、字段一致性和撤稿状态需要分开：真实 DOI 可能配错题名，未查到撤稿也不等于已证实没有撤稿。候选相似度不能证明文献身份或论断支持；新查询应复用 Roc 的 provider、取消、缓存与请求治理。

转换、依赖清理与绘图都须绑定明确来源及哈希。工作区编辑和受控批准稿件各有来源；派生投稿包保留原始文件，DOCX 不承诺模板布局或 Zotero 动态字段。方法图不伪造定量 data trace。缓存先保证版本、环境和定位正确，再测冷/热收益。

## 现行合同入口

P0/P1 当时已实施，不再作为待办；具体输入、错误、版本与 UI 边界集中在以下主文档。

| 能力 | 当前说明 |
| --- | --- |
| Zotero / Better BibTeX 来源键、本地键与冲突映射 | [Zotero](../research-zotero.md) |
| 文献字段检查、Vale 工件/TeX 投影与缓存 | [写作检查](../research-writing-checks.md) |
| arXiv 派生包、六种 CSL、Pandoc DOCX/HTML | [导出](../research-exports.md)、[CSL](../../resources/research-runtime/csl/README.md) |
| Mermaid 静态方法图与 Vega 定量图稿 | [图稿](../research-figures.md) |
| TypeScript/R/Julia/Python 与冻结 Notebook | [实验](../research-experiments.md)、[Notebook](../research-notebooks.md) |
| 工具版本、许可、构建和独立验收 | [工具链](../../resources/research-runtime/README.md)、[验证](../verification.md) |

## 上游目录（调研日观察）

P0/P1/P2 是当时的选型优先级；“借鉴”指规则、算法或交互，“可选适配”指文件/工具协议，“保留”指 Roc 已有适合的实现。完整项目与渲染库、源码与分发包分别判断，许可不自动覆盖插件、字体、字典、模板及传递资源。

### 1 编辑器与写作环境

| 项目 | 调研时的能力与依赖 | 当时对 Roc 的建议 |
| --- | --- | --- |
| [Marktext](https://github.com/marktext/marktext) | MIT；完整 Markdown 桌面编辑器，所见即所得与多种编辑模式 | 借鉴编辑体验；不替换 CodeMirror 或壳层。迁移会连带改变文稿模型、快捷键、IME 和保存语义 |
| [R Studio](https://github.com/rstudio/rstudio) | AGPL-3.0；完整 R IDE，含调试与项目环境 | 保持外部工具互操作；嵌入 IDE 与当时助手/终端职责重叠 |
| [bookdown](https://github.com/rstudio/bookdown) | GPL-3.0；R Markdown 长文、章节引用和图书编译 | 有整本专著需求时适配源文件或成品；不替换 Roc 的实验执行 |
| [R Markdown](https://rmarkdown.rstudio.com/) | R/knitr/Pandoc 组成的动态文档工作流 | 支持用户现有 `.Rmd` 项目时再做环境适配；运行代码需经过 Roc 的执行授权、资源和记录边界 |
| [Vim](https://www.vim.org/) | 完整终端编辑器；Vim 自身许可 | 外部打开及键盘效率参考，不能作为 React 编辑组件直接替换 |
| [fzf-bibtex](https://github.com/msprev/fzf-bibtex/#readme) | BSD-3-Clause；Go 程序配合 fzf/bibtool 做文献模糊选择 | 借鉴“搜索—预览—插入 cite key”和索引复用；无需随包引入终端工具链 |
| [vim-pandoc](https://github.com/vim-pandoc/vim-pandoc) | MIT；Vim 中的 Pandoc 写作支持 | 借鉴引用补全、折叠与导航；插件依赖 Vim 宿主 |
| [vim-pandoc-syntax](https://github.com/vim-pandoc/vim-pandoc-syntax) | MIT；Pandoc Markdown 语法高亮 | 用于语法边界对照，不直接迁移 Vim 高亮规则 |
| [Visual Studio Code](https://code.visualstudio.com/) | 完整 IDE；源代码与微软分发产品的条款有区别 | 支持外部编辑工作流；不引入第二个编辑器宿主 |
| [Markdown All in One](https://github.com/yzhang-gh/vscode-markdown/#readme) | MIT；VS Code 扩展，目录、格式与快捷编辑 | 借鉴小交互，不能按普通 npm UI 库接入 |
| [Markdown Preview Enhanced](https://github.com/shd101wyy/markdown-preview-enhanced) | 列表所链仓库当时偏文档；代码在 [VS Code 扩展仓库](https://github.com/shd101wyy/vscode-markdown-preview-enhanced)，NCSA 许可 | 参考预览/导出体验；不整体接入其转换与代码执行栈 |
| [Zettlr](https://www.zettlr.com/) | GPL-3.0；集成 CSL、BibLaTeX、Pandoc 的 Electron 写作应用，[源码](https://github.com/Zettlr/Zettlr) | 产品参考价值高，直接替换价值低；借鉴导出配置与引文交互，保留 Roc 的证据与任务模型 |

### 2 文献与引文

| 项目 | 能力与边界 | 当时对 Roc 的建议 |
| --- | --- | --- |
| [CSL styles / editor](https://editor.citationstyles.org/) | [样式仓库](https://github.com/citation-style-language/styles) 使用 CC BY-SA 3.0；locale 为独立资源 | P1，精选扩展。当时已有 APA、IEEE、GB/T 7714；固定样式、父样式和 locale 版本 |
| [citecheck](https://github.com/tobiasosDev/citecheck) | MIT，TypeScript/Node；参考文献存在性、字段匹配和撤稿线索 | P0，借鉴纯匹配逻辑；不要直接把 CLI 的 `verified` 当作科学可靠性结论 |
| [JabRef](https://www.jabref.org/) | [MIT Java 桌面文献管理器](https://github.com/JabRef/jabref)，以 `.bib` 为中心 | 通过 `.bib` 往返互操作；不替换 Roc 文献库或随包加入 Java GUI |
| [ScholarRef](https://github.com/brodie-neuro/ScholarRef) | MIT；Python，Windows 优先的 DOCX APA 7/Harvard/Vancouver 转换；公开校验管线有限 | 暂不集成。不能据 README 推断其能保留所有 Word 引文字段、修订和复杂排版 |
| [Zotero](https://www.zotero.org/) | 外部文献管理应用，[源码](https://github.com/zotero/zotero)；Roc 已接本地 API | P0，完善现有适配器、版本兼容和来源映射，不嵌入整个 Zotero |
| [Better BibTeX for Zotero](https://retorque.re/zotero-better-bibtex/) | [MIT 插件](https://github.com/retorquere/zotero-better-bibtex)；公式、稳定键与 BibLaTeX 导出；Zotero 8 引文键已迁移到原生字段 | P0，兼容外部键与导出文件；不直接读取 BBT 私有数据库 |
| [Zotero OCR](https://github.com/UB-Mannheim/zotero-ocr) | AGPL-3.0；依赖 Tesseract/Poppler 使扫描件可搜索 | 接收其处理过的 PDF 即可。替换现有 OCR 需先比较相同语料上的准确率、延迟与资源成本 |
| [ZoteroBib](https://zbib.org/) | 在线快速参考文献服务；[FAQ](https://zbib.org/faq) 说明默认浏览器本地保存，分享会上传副本 | 交互参考；不通过自动化网页作为生产文献后端 |

### 3 科研插图

| 项目 | 能力与代价 | 当时对 Roc 的建议 |
| --- | --- | --- |
| [draw.io / app.diagrams.net](https://app.diagrams.net/) | [完整图形编辑器](https://github.com/jgraph/drawio)，源码 Apache-2.0；图标/模板资源另有条款 | P2，优先导入/导出 `.drawio`、SVG/PDF 互操作；完整嵌入会增加大编辑器、工具栏和序列化体系 |
| [Graphviz](https://graphviz.org/) | DOT 图布局；当时 EPL-2.0，原生或 WASM 均需评估 | P2，较大关系图/依赖图候选；需验证 macOS arm64 构建、包体和复杂布局稳定性 |
| [Mermaid Live Editor](https://mermaid-js.github.io/mermaid-live-editor/) | Mermaid 文本生成流程、时序等图；Live Editor 为完整网页，不能等同于渲染库 | P1，接入 [Mermaid](https://github.com/mermaid-js/mermaid) 渲染能力即可；不要内嵌整个在线编辑站 |
| [Vega Lite](https://vega.github.io/vega-lite/examples/) | BSD-3-Clause；声明式定量图表、数据变换和编码 | 保留。Roc 已集成并附带数据轨迹；更换会损失现有可复现能力 |
| [PlantUML](https://plantuml.com/) | Java 生态，UML 强；不同分发包有不同许可证选项 | 暂缓。只有明确 UML/工程图需求才选定具体产物；不能用一个仓库标签概括全部分发许可 |

### 4 转换与出版

| 项目 | 调研时的能力与依赖 | 当时对 Roc 的建议 |
| --- | --- | --- |
| [Cicero](https://cicero.xyz/) | 目录仍称 Python；[原仓库](https://github.com/bast/cicero) 说明 2026 年重写为 Rust，并迁到 [Tangled](https://tangled.org/radovan.xyz/cicero)，服务 remark/reveal/marp 幻灯片 | 低优先级可选幻灯片适配；新实现未做源码审计，不按旧目录描述安装 Python 包 |
| [docutils](https://docutils.sourceforge.io/docs/) | Python，reStructuredText 转换；主要公共领域，个别文件另有许可 | 仅有 RST 输入需求时引入；[镜像](https://github.com/docutils/docutils) 可查 COPYING，非统一无条件许可 |
| [Jupyter Book](https://jupyterbook.org/en/stable/) | 当时第 2 代以 MyST 引擎为基础；旧 v1 是 Sphinx 路线 | P2，研究网站/可复现书籍出版；不要照旧教程默认搭建 Sphinx + MyST-Parser 全栈 |
| [Manubot](https://manubot.org/) | [Python/Pandoc/Panflute 工作流](https://github.com/manubot/manubot)，持久标识符引用、可复现构建；BSD-2-Clause Plus Patent | 借鉴标识符规范化、引用追踪与构建记录；Roc 已有 provenance，无需移植整套写作系统 |
| [latex2arxiv](https://github.com/YuZh98/latex2arxiv) | MIT Python CLI；依赖收集、删无用文件/注释/草稿标记、投稿检查 | P1，借鉴算法与检查集合。其清理会改字节，不能直接覆盖 Roc 已批准源文件和哈希记录 |
| [MyST / MyST-Parser](https://myst-parser.readthedocs.io/en/latest/) | MIT；Python 的 Markdown 解析器，面向 docutils/Sphinx | 有 Sphinx 项目互操作需求时使用；不要和 Node 的 mystmd 混为一个可替换库 |
| [MyST Markdown CLI](https://mystmd.org/) | [MIT Node/TypeScript 工具链](https://github.com/jupyter-book/mystmd)，语义 Markdown、引用、交叉引用与多格式出版 | P2，可作语义出版适配器；不能直接替换当时 LaTeX 真源和执行账本 |
| [nbconvert](https://nbconvert.readthedocs.io/en/latest/) | BSD-3-Clause；Python/Jinja，Notebook 转 HTML/PDF/Markdown/Slides 等 | 可选 Notebook 出版适配；转换与执行要分开，不替换 Roc 的安全解析和冻结运行 |
| [Pandoc](https://pandoc.org/MANUAL) | GPL-2.0-or-later；独立转换程序，内置 citeproc、Lua filters | P1，优先 DOCX/HTML；不替换引用编解码，不能承诺复杂 LaTeX 无损往返 |
| [Pandoc filters](https://github.com/jgm/pandoc/wiki/Pandoc-Filters) | 插件目录，包含交叉引用与 AST 变换等；每项版本/许可各异 | 先用内置 citeproc 和最少的 Lua filter；确有缺口再引入特定 filter |
| [Panflute](http://scorreia.com/software/panflute/) | BSD-3-Clause；Python 的 Pandoc AST 操作接口 | 仅复用已有复杂 Python filter 时有必要；简单转换优先 Lua，避免额外环境 |
| [Quarto](https://quarto.org) | 当时 [CLI 源码 MIT](https://github.com/quarto-dev/quarto-cli)；组合 Pandoc、Jupyter/Knitr/Observable 等，依赖仍各自许可 | P2，外部项目与出版配置适配；不默认引入第二套执行与缓存体系 |
| [Typst](https://github.com/typst/typst) | Apache-2.0；排版、公式与参考文献，支持增量编译 | 保留并扩展现有报告模板。LaTeX 期刊模板继续走 Tectonic，不能以“快”证明应全面替换 |

### 5 拼写、语法与格式检查

| 项目 | 解决的问题 | 当时对 Roc 的建议 |
| --- | --- | --- |
| [GNU Aspell](http://aspell.net/) | 拼写；LGPL 系列核心，字典另有许可；官方仍有新版本 | 暂不新增并行拼写引擎；若发现 Vale 词典能力缺口再评估，不能仅凭项目年代认定过时 |
| [Hunspell](http://hunspell.github.io/) | 词形/拼写；LGPL/GPL/MPL 三许可选择，字典独立 | 可作为词典能力专项候选；先测目标语言语料，避免与现有检查重复 |
| [LanguageTool](https://languagetool.org/) | LGPL-2.1+ 核心；Java 本地服务或远程语法 API | P2，补充真正的语法需求。需实测常驻内存、冷启动与目标语言覆盖；不承诺完整中文语法支持 |
| [LanguageCheck](https://github.com/JohannesBuchner/languagecheck) | BSD-2-Clause；Python/NLTK/Hunspell/ImageMagick，英语 LaTeX 写作启发式 | 借鉴规则与定位案例，优先转成 Roc/Vale 规则；不引入整套依赖 |
| [Markdown lint tool](https://github.com/markdownlint/markdownlint) | 清单指向 Ruby 的 `mdl`，不是 DavidAnson 的 JavaScript markdownlint | 暂不集成 Ruby runtime；仅结构规范需求不值得引入完整新运行时 |
| [mdformat](https://mdformat.readthedocs.io/en/stable/) | MIT Python；CommonMark 格式化，可加 MyST/GFM 插件 | 有 Markdown 真源时才考虑；格式化会改文本，必须预览 diff，验证公式/引用扩展兼容 |
| [proselint](https://github.com/amperser/proselint) | BSD-3-Clause Python；英语文风 | 借鉴少量高质量规则；与 Vale 重叠较多，不能用文风偏好机械判错 |
| [remarklint / remark-lint](https://github.com/remarkjs/remark-lint) | MIT JavaScript/unified；Markdown 结构规则 | 如果扩展 Markdown 写作，优先验证这类现有 JS 生态方案；与 prose 检查分层 |
| [restructuredtext-lint](https://github.com/twolfson/restructuredtext-lint) | Unlicense Python；RST 语法检查 | 无 RST 编辑需求时不接入 |
| [rumdl](https://github.com/rvben/rumdl) | MIT Rust；Markdown lint/format、缓存和多种方言 | P2 性能候选，须与同语义的 Markdown linter 比较；不能替换 Vale 的科研文风规则 |
| [textlint](https://textlint.github.io/) | MIT Node，可插拔自然语言/Markdown 检查；核心不带默认规则 | 有明确且 Vale 无法满足的语言规则包时再选用；评估具体插件质量，不能只比较引擎 |
| [textidote](https://sylvainhalle.github.io/textidote/) | GPL-3.0 Java，结合 LanguageTool 做 LaTeX 文本检查与定位 | 借鉴 LaTeX 到文本的 source map；整包接入须证明语法收益足以承担 Java 常驻成本 |
| [Vale](https://github.com/errata-ai/vale) | MIT；可扩展 prose lint、术语与风格规则 | 保留。优先解决检查对象、规则质量、定位和缓存；它并非完整语法分析器 |
| [write-good](https://github.com/btford/write-good) | MIT JavaScript；英语被动语态、冗词等启发式 | 少量规则参考。科研方法段的被动语态不应一律判错；默认增加会造成重复和噪声 |

### 6 模板

| 项目 | 适用场景 | 当时对 Roc 的建议 |
| --- | --- | --- |
| [Paper Templates for GitHub Pages](https://github.com/dev-onejun/paper-templates-for-github-pages) | Apache-2.0；论文/CV 展示网站 | 可作项目展示模板参考，不能当作期刊官方排版要求 |
| [bookdown-demo](https://github.com/rstudio/bookdown-demo/#readme) | CC0；最小图书项目 | 用作外部 bookdown 互操作样本，不默认增加 R 出版链 |
| [Eisvogel](https://github.com/Wandmalfarbe/pandoc-latex-template) | BSD-3-Clause；Pandoc 3 + LaTeX 宏包，讲义、报告与练习版式 | 可选报告模板。先验证 Tectonic 宏包兼容；不能取代所有期刊模板或现有 Typst 报告 |
| [PhD thesis Markdown template](https://github.com/tompollard/phd_thesis_markdown#readme) | MIT；Pandoc、crossref 与 TeX 的论文目录组织；仓库更新较早 | 借鉴目录和资源组织。固定可运行版本，不能直接复制旧安装脚本作为当时方案 |

### 7 教程

| 教程 | 阅读与适用性 | 对 Roc 的启发 |
| --- | --- | --- |
| [3 frameworks into one — R Studio](https://blog.devgenius.io/write-your-whole-paper-in-r-it-is-better-77e1843f0c09) | 2022 年文章，仅公开节选；R Markdown + Zotero + Notion | 说明文献、笔记、写作互通的重要性；不能据此推荐新增 Notion 同步或沿用旧命令 |
| [Book on Riemann solvers](https://github.com/clawpack/riemann_book/#readme) | 阅读项目说明；Notebook 输出与版本控制分离、执行后出版；代码许可不自动覆盖全书内容 | 借鉴“源文件简洁、发布物带执行结果”，但执行由 Roc 冻结环境与账本管理 |
| [Tenen / Wythoff：Sustainable Authorship](https://programminghistorian.org/en/lessons/sustainable-authorship-in-plain-text-using-pandoc-and-markdown) | 纯文本、引用与 Word/Pandoc 工作流；安装细节需按当时手册复核 | 支持保留开放源文件格式，并明确转换边界 |
| [Quarto combines R & Python](https://blog.devgenius.io/heads-up-quarto-is-here-to-stay-aa861ef87491) | 2022 年文章，仅公开节选；包含早期 M1/reticulate 环境经验 | 证明环境兼容是实际成本；不把旧修复步骤直接用到当时 macOS |
| [Write your dissertation in RMarkdown](https://ourcodingclub.github.io/tutorials/rmarkdown-dissertation/) | 学位论文的章节、图表、参考文献组织 | 可转为 Roc 模板示例与验收语料，而非要求用户迁移写作真源 |
| [Emacs Org-mode for ACPD](https://www.draketo.de/english/emacs/writing-papers-in-org-mode-acpd) | 文本与 LaTeX 混合；作者后续建议细节投稿修改转到 LaTeX 处理 | 支持保留可直接编辑的 `.tex` 交付；不必给 Roc 添加 Org 编辑器 |

### 8 其他资源列表

| 列表 | 后续用途 | 本次边界 |
| --- | --- | --- |
| [Awesome Jupyter](https://github.com/markusschanta/awesome-jupyter/#renderingpublishingconversion) | Notebook 渲染与出版的下一轮候选库 | 未递归阅读所有项目 |
| [Awesome LaTeX](https://github.com/egeerardyn/awesome-LaTeX/#readme) | TeX 工具、编辑辅助及模板专项调研 | 未据目录数量判断集成价值 |
| [Awesome Markdown](https://github.com/BubuAnabelas/awesome-markdown/#readme) | Markdown 解析与编辑生态 | 仅在确定新的 Markdown 产品需求后筛选 |
| [Delightful Open Science](https://codeberg.org/teaserbot-labs/delightful-open-science) | 开放科研与数据发布的导航 | 不构成新增服务、账户或远程发布的授权 |

## 2026-11-07 验收摘要

命令均在仓库根目录执行；数字保留当时记录，没有在本次文档同步重跑。

| 检查 | 历史结果 |
| --- | --- |
| `node --test tests/unit/zotero-import.test.mjs` | 40/40 通过 |
| `node --test tests/renderer/zotero-import.test.mjs` | 20/20 通过 |
| 14 个受影响单元/界面测试文件 | 91/91 通过，覆盖文献/Vale/arXiv/导出合同、预览失效/重放、键盘与窄窗口 |
| `node --test tests/integration/research-scientific-writing-runtime.test.mjs` | 真实 Vale、六种 CSL 的 Typst PDF、Pandoc DOCX/HTML、Tectonic 派生 ZIP，4/4 通过 |
| `node --test tests/integration/research-diagram-runtime.test.mjs` | 隔离 Electron 渲染与输出/清理，1/1 通过 |
| `pnpm generate:ipc`、`pnpm check:ipc`、`pnpm build` | 通过；生成 IPC 没有额外差异 |
| `pnpm check:renderer-chunks` | 通过，eager JS 为 1,135,605 bytes / 8 files，Mermaid 未进入 eager graph |

并发构建/测试时曾有一次 Chicago 样式 Typst 非零退出且 stderr 为空；相同输入直接编译及后续隔离运行通过，根因未确定。这些结果没有证明稳定性问题已修复。实施当时未提交、推送、签名发布或完成全仓测试。

## 历史验证的边界

受控 provider 响应不证明真实网络可用性。Vale 只检查保存目标与支持的投影；arXiv 未上传或在目标服务器编译；DOCX 仅核对包内 XML/媒体及 HTML，未用 Word/LibreOffice 人工目视验收。Mermaid 文件可解析不证明布局或科学含义正确；当前能力边界见上面的主文档。

当时确认 Vale 重复输入命中缓存并避免再次启动检查进程，但没有端到端时延、内存或安装包增量基准。chunk 检查只证明依赖隔离。性能复现统一见[性能文档](../research-performance.md)，比较须固定输入、版本、资源与硬件，保留冷/热、失败及正确性结果。

Graphviz、MyST/Jupyter Book、Quarto 与其他 P2 适配不在当时实施范围。任何后续出版或执行仍须明确产物来源；本文的目录和推荐不构成新增功能、外部发布或质量通过的证据。
