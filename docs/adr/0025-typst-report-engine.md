# 导出附带报告用 Typst，不替换 LaTeX 主链

## 背景

科研导出同时需要论文正文、可重编译源码和便于人工审核的过程报告。用户 LaTeX 模板与投稿源码要求构成正文主链的既有合同。

## 决定

1. 批准的正文继续生成确定性 LaTeX，经 Tectonic 编译并使用共享 PDF.js/Canvas 路径生成预览。模板、引用和源码交付保持同一条链路。
2. [`typst-report.ts`](../../src/main/plugins/research/typst-report.ts) 生成过程报告：项目目标、本版规模、证据索引、图稿清单和 CSL 参考文献，不维护第二份论文正文。
3. 报告使用 Typst 原生 CSL 引擎与锁定的[样式资源](../../resources/research-runtime/csl/README.md)。工具版本和许可统一由[科研运行时](../../resources/research-runtime/README.md)维护。
4. `report.pdf` 和可编辑的 `report.typ` 均为必需交付文件。报告生成失败则导出失败，不能批准缺少报告的包。

## 理由与代价

报告有独立的版式与审核需求，Typst 可直接处理其排版与 CSL。全面替换正文会改变模板、引文完整性和投稿源码合同，缺少足够收益依据。

工具链增加一个二进制、锁文件条目、许可与 smoke 维护面。编译在隔离原生进程中离线执行，`--root` 限定本次 job，字体限定在允许目录；renderer 通过 `files.preview*` 读取预览。完整交付和失败边界见[导出合同](../research-exports.md)。

目标投稿系统的源码要求改变，或出现独立排版产品线时，再重审此决定。
