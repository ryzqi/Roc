# Release Candidate Checklist

## Verification Commands

Run the gates **serially**: Electron's process singleton lock rejects parallel instances
(`electron.launch: Process failed to launch`).

- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc typecheck`
- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc node --test tests/unit/`
- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc build`（先 `rm -rf dist/renderer`）
- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc check:renderer-chunks`（eager 预算与 forbidden 名单）
- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc check:ipc`（后端契约零改动的证明）
- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test`（新壳 smoke：启动 / 门户建项目 / 一轮 run / 设置保存 / 文件·Git·终端）
- [ ] `pnpm verify:p3-workspace` … `pnpm verify:p9-management`（七个阶段闸门，逐个跑；工件在 `.artifacts/pN-gates/`）
- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc smoke:electron`（新壳 smoke + 审批与人工闸门深度路径）
- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc audit:layout`（三视口 × 门户/画布/助手/设置；截图在 `.artifacts/layout-audit/`）
- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc smoke:performance`
- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc package:dir`
- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc verify:native-packaging`
- [ ] packaged app contains `Contents/Resources/research-toolchain/manifest.json` and `licenses/python-packages.json` for the current architecture
- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc verify:paths`
- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc package:mac`
- [ ] `package:mac` 产出当前架构 `Roc.app`（Apple Silicon：`release/mac-arm64/Roc.app`；Intel：`release/mac/Roc.app`），不生成 zip/dmg
- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc smoke:mac`

工件检查：

- [ ] 每个闸门的 `report.json` 里没有 `"ok": false`；说明性记录（`kind: "info"`）数量与阶段文档一致
- [ ] `pnpm test` / `pnpm smoke:electron` 的 `result.json` 里 `failed === 0`
- [ ] 截图与 JSON 都落在 `.artifacts/` 下（gitignore），不手工改

## 单前端检查（切换后）

- [ ] `ls src/renderer` 只有新壳；`research-studio/` 不存在
- [ ] `grep -rn "renderer-next\|research-studio" src/ scripts/ tests/` 只剩注释里的历史说明
- [ ] 旧前缀 `research-*` / `chat-*` / `workbench-*` / `settings-view` 不再出现（`design-system/MASTER.md` §12）

## Owner Approval

Get owner approval before:

- tagging a release
- pushing to `main`
- publishing the packaged `.app`
- changing supported macOS architecture targets
- adding signing certificates or update server config
