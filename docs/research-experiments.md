# 科研实验运行

新实验支持 TypeScript、R 和 Julia。Python 运行记录与源文件仍可查看、导出及追溯，但不能启动或重跑。`startExperiment` 选择引擎与源；未提供 `expectedEnvironmentHash` 时，主进程先检查运行时。Agent 可传入环境摘要以固定重放。每次新运行使用新的 `requestId`，相同请求重发返回已有运行。

TypeScript 使用 `{ engine: "typescript", runtime: { kind: "bundled-node" } }`，源文件扩展名为 `.mts`，`sourceVersion` 为 `1`。Electron 45 内置的 Node 24.22.0 直接剥离 TypeScript 类型，不运行额外转译器。模块必须导出 `async function run(context)`，并以 `undefined` 结束；需要保留的结果通过 `context.files` 写入输出目录。源文件及 `inputPaths` 会先复制到只读快照中。

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

TypeScript 源码使用 Node 支持的可擦除类型语法；运行时不安装项目包。文件接口只读取快照中声明的路径，单文件最多 64 MiB、每次总输入最多 256 MiB、CSV 最多 100,000 行。输出单文件最多 64 MiB、总量最多 128 MiB、最多 1,000 个文件。Node 权限模型和 macOS 沙箱限制读取、写入、进程启动及网络；网络访问仍由每次运行的 `network` 选项显式控制。任务同时受超时与取消控制。

R 使用 `{ kind: "renv", rootPath, libraryPath }`：`rootPath` 是所选 R 的 `R.home()` 绝对目录，`libraryPath` 是项目内的相对库目录。项目须有 `renv.lock`，库中须有 `renv`；支持 renv 创建的包缓存链接。运行前检查 R 版本、`renv::status()` 与实际包描述，锁文件中的 R/包版本不符会失败。R 以 `--vanilla` 启动，不加载项目或用户启动配置；使用指定库和该 R 自带的库，不恢复额外的 site-library。

Julia 使用 `{ kind: "julia", rootPath, depotPath }`：`rootPath` 包含 `bin/julia`，`depotPath` 指定已准备的 depot，均为绝对目录。预检使用所选 Julia 的 Pkg 检查 Project/Manifest 是否同步、依赖和 artifacts 是否已安装，以及 Manifest 中的 Julia 版本。实际选中的项目/版本化 Manifest、工作区项目配置、JuliaLocalPreferences/LocalPreferences 和 JuliaArtifacts/Artifacts 配置会保存到输入快照，保留 Julia 自身的文件选择优先级。运行关闭 startup 文件和自动预编译，使用已有编译缓存；不加载默认全局环境。本地相对路径依赖的 Project.toml 与源码需要一并声明为输入，绝对路径依赖会被拒绝。

R/Julia 解释器、包元数据及锁文件摘要均纳入环境指纹，运行结束时再次校验。未声明版本的 Julia 包将版本记录为 `null`。应用不安装 R/Julia 或修改其项目库/depot；所选运行时需与当前 macOS 兼容。

`sourcePath` 和 `inputPaths` 均为项目内相对路径。项目外文件、符号链接和路径越界会失败；原项目中的输入保持只读。R/Julia 的脚本参数进入 `commandArgs(trailingOnly=TRUE)` 或 Julia `ARGS`；TypeScript 参数通过 `context.parameters` 提供。R/Julia 输出写入本次输出/临时目录，标准输出和错误单独保存。

成功运行的持久记录保存输入/输出哈希清单、环境、日志和可检索的文本结果。`readExperimentFile` 读取已登记文件（预览上限 4 MiB）；资源 URL 按运行、文件与内容哈希核验。来源内容变化会拒绝读取。证据可以通过 `getEvidenceExperimentSource` 回到对应实验文件。

`publishExperiment` 从已提交的运行记录生成并校验 JSON 清单，再关联实验阶段的流程工件及 provenance；需要项目处于可编辑的实验阶段。取消会等待进程退出并保存日志，应用关闭或重启恢复时将未完成运行标记为 interrupted。中断运行不自动重复执行，重新运行须使用新 `requestId`，并重新校验环境与当前输入。

阶段 Agent 的写工具由服务绑定当前项目和本次阶段运行。脚本修改使用 `expectedHash`；实验、图稿、导出启动使用新的 `requestId`，重复同一请求返回已有记录。`ownerRunId` 只由服务写入，模型不能指定项目身份。取消或替换阶段运行后，迟到的脚本写入、完成结果和发布都会被拒绝。人工批准和最终 ZIP 交付仍不向模型开放。

实验、绘图和导出阶段的模型输出必须绑定本次运行链已发布的真实工件。系统不会另造 `path=null` 的空产物；未发布时阶段失败并保留模型版本。失败或重试会留下已发布记录，重试成功后把模型 provenance 接到这些工件。手工创建的元数据工件不能代替实际发布。

实验域**没有界面**（[ADR 0024](adr/0024-stage-surface-removed.md)）：启动 TypeScript/R/Julia 实验、读取日志与发布走上面的 capability（`research.experiment.startOwned` / `publishOwned`），由对话代理调用；深链到 `?view=experiments` 会明确失败。`inspectExperimentEnvironment` 供 Agent 与诊断，不是 UI 前置。任意本机 R/Julia 包的源码并非完整打包快照；环境摘要记录实际包版本、安装元数据及项目锁文件，运行前后都会重新检查其一致性。

修改 R 进程适配器时，构建机需要 macOS 的 Command Line Tools；以下命令只构建 arm64 库，并更新源码与二进制哈希。应用运行时直接使用已构建资源。

```bash
node scripts/research/build-r-process.ts
```
