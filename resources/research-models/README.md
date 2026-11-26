# 原生文档解析模型

基础模型由应用在用户主动选择后下载到模型目录。源码仓库不包含 ONNX 权重。[`models.lock.json`](./models.lock.json) 固定每个文件的 immutable source revision、URL、大小、SHA-256 和许可证；安装与加载前均进行校验。

| 包 | 文件 | 下载量 |
| --- | --- | ---: |
| `compact` | PP-OCRv6-tiny detection/recognition 与字典、PP-DocLayout-S、SLANet | 18,967,109 B |

解析结果和模型包指纹中的推理库版本取自应用实际安装的 `paddleocr` 和 `onnxruntime-node`。

PaddleOCR.js 推理运行库为 MIT。模型按其上游仓库声明使用 Apache-2.0：OCRv6-tiny 与 SLANet 来自 PaddlePaddle Hugging Face 仓库；PP-DocLayout-S 与 OCRv6-tiny 字典来自 `x3zvawq/paddleocr-js-onnx` 的 Paddle 模型 ONNX 转换。具体 revision 与摘要以锁文件为准。

应用默认使用 `compact` 包进行 OCR、版面和表格识别。旧 FormulaNet 与 tokenizer 已从目录和运行路径移除。

`complete` 使用独立的 OvisOCR3 MLX 8-bit 安装，直接下载 Hugging Face 量化权重，不在本机转换。模型下载 1,020,807,733 B，固定 wheels 下载 199,429,047 B；缺少共享 CPython/uv 时另行准备。它们均不进入默认应用包。来源与 SHA-256 见 [`prequantized.lock.json`](../ovis-ocr/prequantized.lock.json)，生命周期见 [安装合同](../../docs/research-ovis-lifecycle.md)。
