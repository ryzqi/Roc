# Task Plan: Roc 界面优化

## Goal
执行《界面优化.md》三个阶段，沿用现有桌面壳、语义 Tokens 与 Motion 预设；每阶段完成必要运行验证并独立 Git 提交。

## Next Step
三阶段实现和定向自动化交付记录已完成，阶段一 `05cf648`、阶段二 `e85d64a`，阶段三与本计划一并本地提交。严格帧预算与实机验收缺口见下方及 docs/ui-library-refinement-2026-11-27.md；不将它们计为通过。

## Current Phase
Delivery

## Phases

### Phase 1: 零重排止血
- [x] 读取需求、两份指定 Skill、项目设计合同与依赖
- [x] 筛选与菜单浮层顶层定位，锁定工具条和列表轨道
- [x] 固定行高，详情和处理阶段迁移至 Inspector
- [x] 验证布局稳定、键盘、明暗主题与窄窗；独立提交
- **Status:** complete

### Phase 2: 8 原则减负重构
- [x] 合并状态、搜索与筛选入口，批量动作仅在选中时显示
- [x] 串联已有导入、补全、解析与索引管线，保留真实状态和安全边界
- [x] 当前项目可逆移除使用解除关联与撤销；统一文献状态、快捷动作与空态
- [x] 验证导入到阅读/问 AI 的运行路径与撤销；独立提交
- **Status:** complete

### Phase 3: 状态动效与压测抛光
- [x] 扩展现有共享 Motion，统一 reduced motion 与状态过渡
- [x] 检查 Inspector、分段控件、图标反馈、删除补位与拖拽跟手
- [x] Electron 宽窄窗、明暗主题、4x CPU 与 1000+ 虚拟列表验证（帧预算未达，见验收记录）
- [x] 运行设计/动效/裁切审计和必要项目检查；独立提交
- **Status:** complete（实现与定向自动化范围；性能验收缺口如下）

### Phase 4: 最终回归
- [x] 按最终改动范围完成项目检查并检查已有提交
- [x] 文档记录检查命令、证据与真实环境限制
- **Status:** complete

### Phase 5: 交付
- [x] 汇总阶段提交、改动文件、验证结果与剩余缺口至交付记录
- **Status:** complete

## Remaining Acceptance
- [ ] 4x CPU 严格 8/16ms 帧预算：RAF P95 32.5ms，当前结果未达
- [ ] 物理 60/120fps 与逐帧 raster damage：当前工具证据不足
- [ ] 物理触控板、系统中文输入法、VoiceOver、外部 Provider 与第二台 Mac 实机验收

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| 沿用 tokens.css、shared/motion.ts、React Virtuoso | 已有成熟系统；不新增第二套设计系统、动效入口或虚拟滚动库 |
| 只本地提交、不推送 | 用户已授权每阶段提交，未请求远程发布 |
| 原始界面优化.md 单独保护 | 起始为用户新增的未跟踪需求文件；不混入自动暂存 |
| 保留后台权限与科学数据严格校验 | 自动化 UI 流程不能绕过已有授权和模型/索引配置 |
| 文件计划及必要并行只用于本任务 | 用户 AGENTS 要求复杂任务使用计划与 subagents |
| 项目移除使用解除关联 | 全库归档会退休科学来源并影响其他项目；现有 linkItem(false/true) 合同适合本项目移除与撤销 |

## Errors Encountered
| Error | Resolution |
|-------|------------|
| CodeGraph 提示旧提取版本 | 不刷新索引；已有源码仍为当前磁盘内容，缺失上下文使用精确查询或 scoped reads |
| 初次计划 patch 使用错误标题 | 修正 progress.md 的三级标题，重新执行；未改动业务源码 |
| 恢复时引用不存在的 CSS / 测试名 | 通过实际文件列表与 Hub 的样式选择器定位，避免推测文件名 |
| 恢复时规划 patch 表头不匹配 | 用已读取的段落锚点追加，未应用失败的整组 patch |
| Undo 恢复文献后原生焦点回落 body | 等待行挂载并验证焦点所有权，补测异步与虚拟化路径 |
| 成功 DOI 请求身份重复复用旧 ledger 收据 | 成功终态释放身份，保留在途 / 未知失败重试身份；增加移除后重加回归 |
| Playwright toMatchAriaSnapshot 依赖自身 runner | 在 node:test 中轮询 locator.ariaSnapshot，验证真实 AX 文本 |
| 当前 Chromium LayerTree 无 layerPainted 事件 | 记录 API 限制，改用真实 Paint / invalidation 节点追踪和 Paint Flashing；不宣称零 raster damage |
