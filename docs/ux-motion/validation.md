# 动效验证

自动化使用隔离资料根和受控服务。复跑前核对源码、构建、硬件、样本和 workload，按[采样协议](benchmark-protocol.md)分别记录 RAF、输入响应代理、主线程 trace 和进程资源。

## P6

原生产构建的五轮样本包含常规动作、减少动态效果、长历史、文献、画布切换和 400 页 PDF。报告与起点对照见[固定测量数据](README.md)，性能结果及其适用范围见[科研性能测量](../research-performance.md#测量入口)。

历史工程回归覆盖布局、控件焦点、包一致性和隔离启动。120 Hz、低功耗、第二台 Mac、VoiceOver、物理触控板、系统中文输入法及真实外部服务需要分别实测。P0～P6 的准确命令、初次失败、补跑与打包记录见[原始验证记录](https://github.com/ryzqi/Roc/blob/0ea0b6c730c0825ce1173325d946cd5457953131/docs/ux-motion/validation.md)。
