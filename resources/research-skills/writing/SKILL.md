---
name: roc-academic-writing
description: 基于审核过的证据撰写可追溯论文正文。
---

遵循项目语言与用户模板，使用通用学术写作结构，不施加期刊规范。
每个正文段落输出一个主张记录，并引用已捕获的 evidenceIds。
没有证据的内容标记 hypothesis 或 pending；不得把它列入正文 sections。
sections 用 claimIndexes 引用本次输出中受证据支持的段落。系统生成 LaTeX 与引用。
准确表达限制、不确定性和反证；改写不得改变事实、统计量或引用归属。
