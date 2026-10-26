# 原生文档解析模型

这些文件由应用在用户主动选择模型包后下载到用户数据目录。源码仓库不包含 ONNX 权重。[`models.lock.json`](./models.lock.json) 固定每个文件的 immutable source revision、URL、大小、SHA-256 和许可证；安装与加载前均进行校验。

| 包 | 文件 | 下载量 |
| --- | --- | ---: |
| `compact` | PP-OCRv6-tiny detection/recognition 与字典、PP-DocLayout-S、SLANet | 18,967,109 B |
| `complete` | `compact` 加 PP-FormulaNet-S 与 UniMERNet tokenizer | 329,850,264 B |

PaddleOCR.js 推理运行库为 MIT。模型和 tokenizer 按其上游仓库声明使用 Apache-2.0：OCRv6-tiny 与 SLANet 来自 PaddlePaddle Hugging Face 仓库；PP-DocLayout-S、PP-FormulaNet-S 与 OCRv6-tiny 字典来自 `x3zvawq/paddleocr-js-onnx` 的 Paddle 模型 ONNX 转换；公式 tokenizer 来自 PaddleOCR 源码树的 `ppocr/utils/dict/unimernet_tokenizer/tokenizer.json`。具体 revision 与摘要以锁文件为准。

应用默认使用 `compact` 包进行 OCR、版面和表格识别。`complete` 包额外启用公式识别；该模型约 309 MB，因此按需单独下载。
