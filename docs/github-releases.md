# macOS GitHub Release 自动发布

仓库的[发布工作流](../.github/workflows/release-mac.yml)在 GitHub 托管 Apple Silicon macOS runner 上重新构建 `release/mac-arm64/Roc.app`，保留现有构建、类型检查、renderer chunks 和打包 smoke，再压缩并上传 GitHub Releases。GitHub 无法读取开发者电脑里的应用目录；本机 `release/` 继续被 Git 忽略。

## 推送与版本

以下操作触发工作流：

| 操作 | Release |
| --- | --- |
| `git push origin main` | `v0.1.0-build.<提交前12位>` 形式的预发布，实际基础版本取 `package.json`；不改正式版 Latest |
| 推送 `v0.1.0` 形式的版本标签 | 标签须等于 `v` 加 `package.json.version`；普通版本发布正式版，含 `-beta` 等后缀的版本保留为预发布 |
| Actions 页面运行 `Publish macOS arm64` | 按所选分支提交或版本标签执行，可重试已有发布 |

正式版示例，先将版本改动提交到仓库，再执行：

```bash
git push origin main
git tag v0.1.0
git push origin v0.1.0
```

`main` 推送与版本标签推送分别产生预发布和版本发布。自动生成的 `-build.`／`.build.` 标签不再触发标签发布，避免本机发布后产生重复任务；这些后缀保留给提交预发布。普通 `git push` 不会自动推送新建标签；版本标签已存在且指向其他提交时，发布脚本直接失败。

PR 不发布：[`Verify macOS arm64 package`](../.github/workflows/verify-mac.yml) 使用只读权限在 macOS runner 上执行发布与 TeX ZIP 单测、完整打包和 `Roc.app` smoke。合并到 `main` 后才会生成该提交的预发布。

## 本地入口与产物

本机发布和 CI 共用 [.node-version](../.node-version) 指定的 Node.js 补丁版本和 [package.json](../package.json) 中的 pnpm 版本。工作流中的外部 Action 固定到发布标签对应的完整提交 SHA。

本机还需要 Apple Silicon macOS、已准备的[科研工具链](../resources/research-runtime/README.md)，以及具有目标仓库写权限的已登录 GitHub CLI。发布脚本通过 `PATH` 调用 `gh`。发布提交须已推送且工作区干净，默认仓库取 GitHub Actions 上下文或 `origin`，可用 `--repo OWNER/REPO` 指定。

```bash
# 查看版本、提交和附件名，不构建或访问 GitHub
pnpm release:mac --plan

# 实际构建、运行打包检查和压缩；不访问 GitHub 或创建 Release
pnpm release:mac --dry-run

# 发布当前已推送提交的预发布，或补全其已有草稿
pnpm release:mac

# 发布与 package.json 版本一致的正式版本
pnpm release:mac --tag v0.1.0
```

`--dry-run` 允许未提交的开发改动，并在结果和 JSON 中标明 `sourceDirty: true`；正式发布拒绝这种来源。脚本重用 `pnpm package:mac`，会更新本机 `Roc.app`。

附件保存在 Git 忽略的 `release/`。例如预发布 `v0.1.0-build.0123456789ab` 上传：

- `Roc-0.1.0-build.0123456789ab-mac-arm64.zip`：用 macOS `ditto` 压缩，保留 `Roc.app`、可执行位和链接。
- 同名 `.zip.sha256`：ZIP 的 SHA-256 校验和。
- 同名 `.zip.release.json`：版本、完整提交 SHA、仓库、架构、附件大小与 SHA-256。

本地另留同名 `.zip.release-notes.md`，用于草稿说明与重试；它不作为附件上传。下载 ZIP 后解压，将 `Roc.app` 移到 Applications。

**当前是开发签名，不是正式的 Apple 分发签名。** `electron-builder.yml` 使用 `identity: "-"`（ad-hoc）及 `hardenedRuntime: false`，发布说明会明确标注未公证。App 可用于开发机安装验证，但 GitHub 下载的 App 可能被 Gatekeeper 阻止首次打开；当前不承诺无需用户批准即可直接安装。不要在自动化中移除下载隔离属性来伪装成公证成功。

## 失败与重试

发布先验证提交和标签，再构建并建草稿。依次上传 ZIP、校验和和 JSON；API 确认各附件的大小、SHA-256 和上传状态后才公开 Release。任何构建、鉴权或上传失败都会返回非零退出码，Actions 显示失败，草稿保留。

已完成的同一提交再次发布时，校验远端来源和三份附件后复用现有 Release，不重新构建或替换附件。ZIP 已上传的草稿再次执行时，沿用草稿中保存的校验和，补传剩余附件并公开。没有附件的脚本草稿可重新构建。

已有标签指向别的提交、草稿缺少本脚本的来源记录，或附件处于异常状态／校验和不一致时，脚本拒绝继续。先查看日志和草稿，修复问题后重试，或使用新版本；不会使用 `--clobber` 删除已有附件，也不会接管旧 Release。

## TeX 完整性与缓存恢复

`tools.lock.json` 固定上游 TeX tar 归档的 URL、大小和 SHA-256；`downloadVerified()` 在使用缓存时仍核实该来源，来源变化直接失败。`tex-bundle-files.txt` 固定选取的文件集合。

`ensureTexBundleZip()` 从已验证的 tar 读取所选文件的大小与 SHA-256，再逐项解压核对 ZIP 的名称、数量、大小和内容摘要，并校验本地／中央目录 CRC 与实际解压内容一致。ZIP 内的 `SHA256SUM` 只验证内部一致性，不能单独证明来源。与当前源归档相符的 ZIP 可以复用；来源内容或文件清单改变、缓存损坏时，由已验证的 tar 重建。重建后的 ZIP 仍不能通过校验则失败，不会发布；仅有 ZIP 而缺少可验证的 tar 时，也不能跳过来源下载或校验。

ZIP 的压缩后字节可能随 zlib 版本或实现改变，因此不再使用 `zipSha256` 作为跨环境的固定值；这**没有取消上游归档的固定 SHA-256 检验**。最终发布的 App ZIP 仍单独计算 SHA-256，并在上传前后与 GitHub Release 附件回执核对。

## 后续 Developer ID 与公证接入点

拥有 Apple Developer Program 的 `Developer ID Application` 证书和公证凭据后再启用正式发行签名：

1. 将签名证书及密码配置为仓库 Actions Secrets（常用环境变量 `CSC_LINK`、`CSC_KEY_PASSWORD`）；按 electron-builder 版本选择 App Store Connect API Key 等公证凭据，不要把私钥写入仓库或工作流日志。
2. 将 [electron-builder.yml](../electron-builder.yml) 中的 ad-hoc `identity` 改为正式 Developer ID，启用 Hardened Runtime 和 notarization；本仓库固定 electron-builder 26，调整时应使用与 26 对应的配置文档。
3. 保留 [`sign.mjs`](../scripts/builder-hooks/sign.mjs) 在实际签名前完成科研工具链资源最终化的顺序，否则签名封印会被随后修改的资源破坏。
4. 增加 `codesign --verify --deep --strict`、`xcrun stapler validate` 与 `spctl --assess --verbose` 门禁，并在**公证完成后**生成分发 ZIP；全链路成功才允许将正式 Release 公开。

目前没有 Developer ID 凭据，因此本次变更只确保开发版构建和如实标注签名状态，不自动启用不可用的公证步骤。

参考：[Apple Developer ID](https://developer.apple.com/developer-id/)、[electron-builder v26 公证](https://www.electron.build/v26/docs/features/code-signing/notarization/)。

## CI 条件

Release 工作流使用 `contents: write` 的短期 `GITHUB_TOKEN` 发布，无需添加个人 token。PR 只读验证工作流不创建 Release，也不在本机安装 Git 钩子或常驻 runner。

依赖按锁文件安装，科研工具链从固定版本和 SHA-256 的归档准备。首次需要下载约 2.88 GB 的 TeX 源归档及原生工具；后续复用下载缓存，但每次按当前源码重新组装、校验工具链。工作流设 90 分钟超时，不会取消正在发布的同一提交任务。

云端构建依赖 GitHub runner、包源和固定下载源可用。发布状态以对应 Actions 运行和 Release 附件回执为准。
