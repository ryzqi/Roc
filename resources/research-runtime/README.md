# 科研 Python 运行时

Python 3.12.14 随应用分发。该版本同时覆盖 Apple Silicon 和 Intel Mac 的已发布科学计算 wheel；两个架构使用同一份 `uv.lock`，仅对 PyTorch、TorchVision、Transformers 与 NumPy 使用必要的架构约束。

Docling 使用 PDFium 后端进行 PDF 解析、布局/表格识别与公式识别；OCR 使用系统 Vision 框架及 MIT 许可的 ocrmac。解析模型不随安装包分发：开发机使用 `.runtime/research-models`，打包后下载到 `~/.roc/research-models`。运行时禁止自动联网拉取。Matplotlib 渲染仍由随包 Python 完成。模板 ZIP、文献、PDF 单页渲染、导出 ZIP 和图稿校验由主进程 TypeScript 实现。

本目录保存源文件和依赖声明。构建得到的解释器、环境与模型位于项目 `.runtime/`，不提交生成的第三方二进制。此增量提供可供应用打包的完整工具链；主进程接线与 Electron 打包校验在后续增量完成。

## 准备和校验

构建机需要与目标架构匹配的 macOS、可直接执行 TypeScript 的 Node 26，以及首次准备时的网络。应用运行时使用随包 CPython。下列命令以当前仓库路径为例；Intel Mac 使用 `--arch x64` 和对应输出目录。

```bash
rtk proxy node /Users/Apple_501/Desktop/Roc/Roc/scripts/research/prepare.ts --arch arm64 --output /Users/Apple_501/Desktop/Roc/Roc/.runtime/research-toolchain/darwin-arm64
rtk proxy node /Users/Apple_501/Desktop/Roc/Roc/scripts/research/manifest.ts --root /Users/Apple_501/Desktop/Roc/Roc/.runtime/research-toolchain/darwin-arm64
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc exec vitest run tests/scripts/research tests/main/native-packaging.test.ts
rtk proxy node /Users/Apple_501/Desktop/Roc/Roc/scripts/research/fetch-models.ts --lock /Users/Apple_501/Desktop/Roc/Roc/resources/research-runtime/models.lock.json --output /Users/Apple_501/Desktop/Roc/Roc/.runtime/research-models
rtk proxy node /Users/Apple_501/Desktop/Roc/Roc/scripts/research/smoke.ts --toolchain /Users/Apple_501/Desktop/Roc/Roc/.runtime/research-toolchain/darwin-arm64 --models /Users/Apple_501/Desktop/Roc/Roc/.runtime/research-models --output /Users/Apple_501/Desktop/Roc/Roc/.artifacts/research-toolchain-smoke
```

`prepare.ts` 按工具归档 SHA-256 与 `uv.lock` 组装 Python / Tectonic / TeX 环境，生成逐文件完整性清单及实际 Python 包许可证索引。模型只写入 `--models` 缓存（默认 `.runtime/research-models`），不复制进 toolchain 输出。解释器和 console script 不依赖开发机 venv。下载缓存位于 `.runtime/research-downloads`；中断后重复命令会使用已完成分块及部分字节。相同输出已存在时执行完整校验；源文件或锁文件变化后需选择新输出目录，避免覆盖已有工具链。

TeX 资源从固定 TAR `tlextras-2022.0r0` 按 `tex-bundle-files.txt` 做成离线编译子集 ZIP。保留原始文件字节，并重写 `SHA256SUM`。源 TAR 哈希、子集 ZIP 哈希均在 `tools.lock.json`。运行时 `tectonic --only-cached`，不下载其余 TeX Live 包。缺包即编译失败。哈希不符、资源身份变化或归档越界都会失败，不会回退到 PATH 中的工具或临时下载其他版本。

`smoke.ts` 使用空缓存和 macOS sandbox 禁止外网，执行中英文 LaTeX 编译、TypeScript PDF 渲染、扫描图 OCR、表格/公式/图稿提取，以及 Matplotlib 的 PNG/SVG/PDF 输出。输出目录必须不存在；成功后写入 `result.json`，并保留 PDF、页面图、解析结果和日志。验证搬迁时将完整工具链复制或移到含空格的新路径后执行同一命令。

## Worker 协议

`worker.py` 只处理 `parse_document`。每次从 stdin 接收一条 JSON 请求，在 stdout 返回 `{"ok":true,"result":...}` 或 `{"ok":false,"error":{"code":...,"type":...}}`；库日志走 stderr。成功退出码为 0，失败为 1。调用时使用私有 Python 的 `-I -B` 参数，外层负责超时、取消、缓存目录和进程权限。

- `parse_document`：必填 `projectRoot`、`sourcePath`、新的 `outputDir`、固定的 `modelsPath`。

路径必须为绝对路径，输入与输出都必须处于项目内；拒绝覆盖已有输出。解析返回带源文件摘要、页码、边界框坐标原点和节点定位的文本/表格/公式/图稿，生成页面图及 Docling 原始结构。任何失败都清理本次新建的输出目录，来源在处理期间变化也会失败。

Worker 使用内置 MIME 类型表；不读取开发机的 Apache 或用户 MIME 配置。异常 traceback 输出至 stderr，便于主进程诊断，JSON stdout 不混入日志。

`figure.py` 仍由随包解释器渲染 Matplotlib 图稿；主进程只负责校验输出。许可证采集由 `scripts/research/collect-licenses.ts` 读取已安装包的 METADATA/RECORD，不再进入目标解释器。
