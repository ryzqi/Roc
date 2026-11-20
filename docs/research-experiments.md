# 科研实验运行

新实验支持 TypeScript、R、Julia 和 Python。Python 使用用户选择并绑定项目的 CPython 环境，可运行 `.py` 文件或冻结 Notebook 的受限单元子集；完整合同见[Python 环境与运行](research-python-environment.md)及[Notebook](research-notebooks.md)。`startExperiment` 选择引擎与源；TypeScript/R/Julia 未提供 `expectedEnvironmentHash` 时，主进程先检查运行时；Python 必须提供已检查的环境哈希、选择回执、`sourceVersion: 1` 和 seed。Agent 可传入环境摘要以固定重放。每次新运行使用新的 `requestId`，相同请求重发返回已有运行。

TypeScript 使用 `{ engine: "typescript", runtime: { kind: "bundled-node" } }`，源文件扩展名为 `.mts`，`sourceVersion` 为 `1`。Electron 内置 Node 直接剥离 TypeScript 类型，不运行额外转译器。模块必须导出 `async function run(context)`，并以 `undefined` 结束；需要保留的结果通过 `context.files` 写入输出目录。源文件及 `inputPaths` 会先复制到只读快照中。

`context` 提供冻结的 `parameters`、声明过的 `inputPaths`、取消信号 `signal`，以及以下文件和统计接口：

- `files.readText(path)`、`files.readCsv(path, { delimiter? })`
- `files.writeText(path, text)`、`files.writeCsv(path, rows, { columns? })`
- `statistics.mean`、`median`、`quantile`、`variance`、`standardDeviation`、`sampleCorrelation`、`linearRegression`

```ts
export async function run(context: {
  parameters: Readonly<Record<string, string>>;
  files: {
    readCsv(path: string, options?: { delimiter?: string }): Promise<Record<string, string>[]>;
    writeText(path: string, text: string): Promise<void>;
  };
  statistics: { mean(values: number[]): number };
}) {
  const rows = await context.files.readCsv("results.csv");
  const values = rows.map((row) => Number(row.value)).filter(Number.isFinite);
  await context.files.writeText("summary.txt", String(context.statistics.mean(values)));
}
```

TypeScript 源码使用 Node 支持的可擦除类型语法；运行时不安装项目包。文件接口只读取快照中声明的路径，单文件最多 64 MiB、每次总输入最多 256 MiB、CSV 最多 100,000 行。输出单文件最多 64 MiB、总量最多 128 MiB、最多 1,000 个文件。Node 权限模型和 macOS 沙箱限制读取、写入、进程启动及网络；当前启动合同固定 `network: "disabled"`，不授予网络访问。任务同时受超时与取消控制。

R 使用 `{ kind: "renv", rootPath, libraryPath }`：`rootPath` 是所选 R 的 `R.home()` 绝对目录，`libraryPath` 是项目内的相对库目录。项目须有 `renv.lock`，库中须有 `renv`；支持 renv 创建的包缓存链接。运行前检查 R 版本、`renv::status()` 与实际包描述，锁文件中的 R/包版本不符会失败。R 以 `--vanilla` 启动，不加载项目或用户启动配置；使用指定库和该 R 自带的库，不恢复额外的 site-library。

Julia 使用 `{ kind: "julia", rootPath, depotPath }`：`rootPath` 包含 `bin/julia`，`depotPath` 指定已准备的 depot，均为绝对目录。预检使用所选 Julia 的 Pkg 检查 Project/Manifest 是否同步、依赖和 artifacts 是否已安装，以及 Manifest 中的 Julia 版本。实际选中的项目/版本化 Manifest、工作区项目配置、JuliaLocalPreferences/LocalPreferences 和 JuliaArtifacts/Artifacts 配置会保存到输入快照，保留 Julia 自身的文件选择优先级。运行关闭 startup 文件和自动预编译，使用已有编译缓存；不加载默认全局环境。本地相对路径依赖的 Project.toml 与源码需要一并声明为输入，绝对路径依赖会被拒绝。

R/Julia 环境身份包含解释器、包元数据、锁文件及声明代码树的完整字节/链接摘要，运行结束时再次校验。未声明版本的 Julia 包记录为 `null`。应用不安装 R/Julia 或修改其项目库/depot；所选运行时需与当前 macOS 兼容。读取范围与审计文件见[执行资源治理](research-execution-resources.md)。

文件源码路径（Python 为 `source.path`，其他引擎为 `sourcePath`）和 `inputPaths` 均为项目内相对路径。项目外文件、符号链接和路径越界会失败；原项目中的输入保持只读。R/Julia 的脚本参数进入 `commandArgs(trailingOnly=TRUE)` 或 Julia `ARGS`；TypeScript 参数通过 `context.parameters` 提供。R/Julia 输出写入本次输出/临时目录，标准输出和错误单独保存。

成功运行的持久记录保存输入/输出哈希清单、环境、日志和可检索的文本结果。`readExperimentFile` 读取已登记文件（预览上限 4 MiB）；资源 URL 按运行、文件与内容哈希核验。来源内容变化会拒绝读取。证据可以通过 `getEvidenceExperimentSource` 回到对应实验文件。

`publishExperiment` 从已提交的运行记录生成并校验 JSON 清单，再关联实验阶段的流程工件及 provenance；需要项目处于可编辑的实验阶段。取消会等待进程退出并保存日志，应用关闭或重启恢复时将未完成运行标记为 interrupted。中断运行不自动重复执行，重新运行须使用新 `requestId`，并重新校验环境与当前输入。

阶段 Agent 的写工具绑定当前项目和实际 owner，脚本修改须传 `expectedHash`。取消/替换阶段后拒绝迟到写入及发布；阶段输出必须关联本次运行链真实发布工件，元数据不能代替执行。失败记录保留，重试接续来源；完整所有权合同见 [ADR 0028](adr/0028-execution-task-ownership.md)。

实验域没有独立阶段页面（[ADR 0024](adr/0024-stage-surface-removed.md)）：对话代理调用 `research.experiment.startOwned` / `publishOwned`，日志、来源和指标审核在[工件检查器](research-artifact-inspector.md)展示。旧 `?view=experiments` 回到默认 LaTeX。Python 环境选择位于管理任务区，由用户发起；`inspectExperimentEnvironment` 提供真实预检。原生包代码身份被完整核对，但运行时和包原件不因此全部随实验打包。

修改 R 进程适配器时，构建机需要 macOS 的 Command Line Tools；以下命令只构建 arm64 库，并更新源码与二进制哈希。应用运行时直接使用已构建资源。

```bash
node scripts/research/build-r-process.ts
```
