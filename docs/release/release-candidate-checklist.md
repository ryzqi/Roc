# Release Candidate Checklist

## Verification Commands

- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test`
- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc typecheck`
- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc build`
- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc package:dir`
- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc verify:native-packaging`
- [ ] packaged app contains `Contents/Resources/research-toolchain/manifest.json` and `licenses/python-packages.json` for the current architecture
- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc verify:paths`
- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc smoke:electron`
- [ ] `smoke:electron` 工件里 `failedChecks` 为空；`retiredChecks` 里应该只有已退役的「对话优先」检查（见 README 「测试」）。出现新的 `failedChecks` 不能当已知问题放过
- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc smoke:performance`（**当前为已知红**：`history-thread-<id>` 选择器已不存在，且多剖面串行启动会撞单实例锁。原因见 README 「已知红：`pnpm smoke:performance`」。修好之前不要把这条当作已通过）

- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc package:mac`
- [ ] `package:mac` 产出当前架构 `Roc.app`（Apple Silicon：`release/mac-arm64/Roc.app`；Intel：`release/mac/Roc.app`），不生成 zip/dmg
- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc smoke:mac`

## Owner Approval

Get owner approval before:

- tagging a release
- pushing to `main`
- publishing the packaged `.app`
- changing supported macOS architecture targets
- adding signing certificates or update server config
