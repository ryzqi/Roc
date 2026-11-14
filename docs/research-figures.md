# 科研图稿

定量图稿由科研角色使用离线Vega-Lite v6和声明的本地CSV/TSV/DSV/JSON生成，无独立图表编辑器。新图稿不执行Python/Matplotlib或任意JavaScript；旧Python图稿仅可读保存产物。数据计算走[实验](research-experiments.md)，非数值方法图见下节。

## 非数值方法图

助手工具 `research_render_diagram` 调用 `research.diagrams.render({projectId, path, expectedHash?})`，读取项目内已保存的 `.mmd`。支持静态流程、时序、状态、类和 ER 图；拒绝配置指令、HTML、交互和外部资源。源码最多 50,000 字节，渲染前后重验 hash；归档项目拒绝生成。

Mermaid 在按需启动的隔离 Electron 窗口渲染，没有 preload 或 Node 权限；产物写入 `diagrams/<id>/`，保存 `source.mmd`、SVG、PNG、PDF 和 manifest，记录来源、渲染器及文件哈希。30 秒超时或取消会销毁窗口并回收准入，失败输出目录清理。输出不带定量 data trace，也不自动成为流程批准的图稿；布局和科学含义须人工核对。类型与资源上限以[源码策略](../src/shared/research-diagram-policy.ts)为准。

## 创建与冻结

startFigure要求engine:vega-lite、sourceVersion:1、新requestId、.vl.json的sourcePath、inputPaths及figure物理尺寸/DPI/seed。路径均相对项目，data.url须精确匹配声明输入。示例spec：

```json
{
  "$schema": "https://vega.github.io/schema/vega-lite/v6.json",
  "data": {"url": "data/results.csv"},
  "mark": "bar",
  "encoding": {
    "x": {"field": "Group", "type": "nominal"},
    "y": {"field": "Improvement", "type": "quantitative"}
  }
}
```

源spec和数据复制到只读快照，远程URL、外部图片/链接/SVG资源拒绝。spec上限4MiB/深度64，单输入64MiB、总256MiB、数据100000行。宽高1–24英寸、DPI72–1200、uint32 seed、总32000000像素以内。seed控制Vega随机源，字体差异仍可能影响渲染。

inspectFigureEnvironment返回Vega/Vega-Lite/Canvas/Node与pipeline hash。start可传expectedEnvironmentHash固定检查环境；省略时记录当前环境。getFigureRun/cancelFigure查询或取消，修改内容使用新请求。

## 渲染与发布

pipeline/6先生成完整SVG布局，再等比缩放、居中到指定物理画布，支持facet/concat/repeat。源码决定密度和留白，须视觉核对。PNG尺寸Math.trunc(inches*dpi)，SVG/PDF为精确point尺寸，背景沿用解析值，显式透明保留；PDF嵌入同一PNG。

成功输出figure.png/svg/pdf、figure-data.json和figure-validation.json。主进程独立核对尺寸、单页PDF及全部SHA-256；失败保留实际日志/产物。data trace为实际scenegraph的post-transform datum，保存场景路径、编译编码、直接字段、常量/不支持通道及spec/环境/编译spec hash。filter/aggregate/formula/stack后的值来自绘制项，不能按输入字段猜指标。最多1000 mark、100000场景遍历项，超限失败。

角色使用start_figure → get_figure → publish_figure的真实runId；失败/取消/中断不能发布。Owned工具绑定项目与有效阶段，get_experiment不查询图稿。冻结旧工具合同不原地扩权，合同变化须新建阶段运行。

可编辑绘图阶段调用publishFigure({projectId,runId,replacesFigureId:null})；发布重验冻结文件和schema2清单，在同一事务关联图稿、工件、provenance及run.artifactId。getFigure/listFigures返回验证、审核与真实runId；recordFigure历史元数据不能替代真实渲染。

## 人工审核与替换

发布状态rendered；图稿说明通过subjectType:figure的Claim关联证据。阶段角色输出接到本次真实图稿；complete重验清单/spec/数据/输出和证据，进入waiting_approval。用户核对完整工件版本后approve，图稿才approved；文件可解析不证明科学支持。

退回后修改并重绘，以replacesFigureId原子替换当前审核集合，旧图标为superseded，来源/主张/事件保留。新图重新关联主张，不继承科学审核；待批准/批准版本须先按流程退回，不直接覆盖。

没有独立路由（[ADR0024](adr/0024-stage-surface-removed.md)），旧?view=figures回到默认LaTeX。检查与数据映射在[工件抽屉](research-artifact-inspector.md)，人工决定仍走助手闸门。登记图稿可按hash读取PNG/SVG/PDF，禁脚本/网络，仅允许SVG内嵌data图片：

```text
roc-preview://research/figures/{encodedProjectId}/{encodedFigureId}/{png|svg|pdf}/{sha256}
```

原工作区修改不改变已冻结来源。批准图稿进入[导出](research-exports.md)，PNG/SVG/PDF随包，其他输入/输出按逐资源交付审查；清单和日志采用公开投影。

## 实际绘制数据映射

inspectFigureConsistency核对真实冻结文件，返回mark、完整编码和直接字段；按mark/offset/limit（最多200）分页。仅直接编码的有限datum可映射，常量、条件、表达式、缺字段不接受；基线值计数不意味着科学指标。

saveFigureConsistencyReview明确绑定mark/channel/field/scenePath、图稿Claim、真实指标Evidence、工件版本、manifest/trace hash、单位规则、最新parent和人工理由。转换/舍入/容差沿用[写作检查](research-writing-checks.md#主张数值与实验指标)。异步读取后重验文件，事务重查主张/证据/结果/版本；不一致照实保存。

不可变回执保存选中编码/item、运行/图稿/trace、主张和指标计算，不复制整份trace。审核头进入工件hash；getFigureConsistencyHistory独立核验stored_receipt和父链，历史不证明当前来源有效。实际datum/编码核对不推断科学意义或最终像素位置。

“检查图稿绘制数据”按需加载，每页20项，累计草稿不随分页丢失；未加入字段锁住翻页/mark切换。人明确选来源及规则，空数值拒绝而不转零。草稿/保存中锁定关闭、刷新、其他审核和阶段决定；同内容重试保留请求ID。当前文件失效隐藏旧成功报告，批准/归档范围只读。

complete/approve、任务验收及导出重验已有直接性/数值审核与实际来源；期间新增审核或版本变化拒绝旧上下文。无映射不证明科学批准。rendered → approved不使现有映射失效，其他内容/来源变化须重查；完整审核历史与脱敏回执见[导出审核快照](research-exports.md#科研审核快照)。
