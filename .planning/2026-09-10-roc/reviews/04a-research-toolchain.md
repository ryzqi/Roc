# Production 4a Review

基点：`39bfab2e57e0700399259646110672bf5cd089a2`。范围：私有 Python/模型/TeX 工具链、可恢复准备脚本、离线解析/PDF 协议、许可证索引及完整性清单。

## Standards

初审发现模型下载使用临时目录，网络失败会删除 Hugging Face 断点。已改为按模型目录与固定 commit 保留 `.downloads`，以文件锁串行保护发布，并在完整文件哈希通过后原子移动。跨次中断恢复回归通过，问题关闭。

收尾补查许可证索引：识别 `licenses/BUILD_LICENSES/icu.txt` 等文件名不含 license 的原始许可文件，保留工具链内相对路径。PDFium 的 19 份许可文件均已索引。定向复查通过。

最终：0 项未解决问题（硬违反 0，启发式判断 0）。

## Spec

独立复核了模型断点恢复与许可证索引修复，0 项未解决问题。本增量提供可用于应用接线和打包的完整工具链；主进程接线、Intel 实机及最终 Electron 打包按后续范围验收。

## Verification

- 私有 Python 3.12.14 执行 `-B -m unittest discover -s /Users/Apple_501/Desktop/Roc/Roc/scripts/research/tests -v`：22 项通过。
- 按固定归档哈希、149 包通用锁和 22 个模型文件哈希完成 arm64 准备。实际环境包含 144 个科研依赖及 standalone 自带 pip；完整性清单覆盖 38,564 个文件/链接，资源约 3.99 GB。
- `smoke.py` 空缓存、sandbox 禁止外网验证通过：中英文 LaTeX 与公式、PDF 页面渲染、扫描图 OCR、表格/公式/图稿提取、原生 PDF、HTML、PNG/SVG/PDF 绘图、Notebook 和 console script。
- 搬迁至含空格路径后离线 smoke 通过。扫描样例正确保留 12/18/50 和 E=mc²，8 个块、无解析警告；原生 PDF 7 块，HTML 3 块，Notebook 输出 30。
- 最新完整证据：`.artifacts/research-runtime-smoke-03/result.json`；搬迁证据：`.artifacts/research-runtime-smoke-02/result.json`。smoke 前后完整性校验通过。
- `git diff --cached --check`：通过。

状态：Verified passing。
