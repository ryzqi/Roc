# Python 与 uv 历史验收

当前行为见[Python 环境](research-python-environment.md)、[进程准入与隔离](research-execution-resources.md)和[数据库维护](database-storage.md)。

2026-11-25 的 macOS arm64 验收覆盖实际项目准备、私有运行时安装、真实 Electron 启动与相关单元合同。使用 Apple M1 Pro、已验证的本地归档与暖缓存，以[项目准备基准](../scripts/benchmark-python-project-preparation.mjs)各执行五轮空项目准备与再次复核，中位数分别为 12.66 秒和 10.87 秒。范围包含声明、锁文件、环境和代码身份检查。早期[工具链基线](research-toolchain-baseline.md)的执行范围与 Python 版本不同，无法直接比较。科学包首载仍有系统签名校验耗时波动。

原生进程组建立修复的历史压力测量是修复前 3/2048 次失败，修复后 0/2048。正式复跑见 `pnpm test:research-resources`。完整验收命令、测量条件和历史限制见[原始记录](https://github.com/ryzqi/Roc/blob/0ea0b6c730c0825ce1173325d946cd5457953131/docs/research-toolchain-python.md)。
