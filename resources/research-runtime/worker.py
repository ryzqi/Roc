"""Roc 科研工具的 JSON 进程边界。

唯一文档解析引擎是 MinerU 4.x 的无状态 SDK。这里只做四件事：
1. 校验请求、源文件与真实格式（预检，不产出解析结果）；
2. 用冻结配置调用 MinerU，并强制 torch/MPS 小模型后端；
3. 把 MinerU 的 MiddleJson 适配成 Roc 的版本化结果契约；
4. 完整保存原始工件（MiddleJson、Markdown、structured_content、图片），
   任何失败都清理输出目录，不留伪成功结果。
"""

from __future__ import annotations

import contextlib
from dataclasses import dataclass
import hashlib
import importlib.metadata
import json
import math
import mimetypes
import os
from pathlib import Path
import re
import shutil
import sys
import traceback
from typing import Any, TypedDict

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
# MinerU 注册类型时只使用随解释器提供的表，不读取主机 MIME 配置。
mimetypes.knownfiles = []
mimetypes.init(files=[])

MAX_PAGE_PIXELS = 25_000_000
MAX_PAGES = 1000
MAX_SOURCE_BYTES = 512 * 1024 * 1024
SUPPORTED_SUFFIXES = {
    ".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp", ".html", ".htm",
}

# MinerU 的档位名称。HTML 本期固定 flash，其余按用户选择。
TIERS = ("basic", "standard", "advanced", "flash")
# 需要加载大模型（VLM）的档位；其余档位只能给 `auto`（MinerU 配置的 enum 不接受空串，而
# 非 VLM 档位不会实例化引擎，因此 `auto` 是真实的“不指定”）。
VLM_TIERS = {"standard", "advanced"}
VLM_ENGINES = {"auto", "llama-cpp", "mlx"}
DEVICES = {"mps", "cpu"}
OCR_MODES = {"auto", "txt", "ocr"}


class Location(TypedDict):
    page: int
    bbox: list[float]
    coordinateOrigin: str


class Block(TypedDict):
    id: str
    kind: str
    label: str
    text: str
    locator: str
    locations: list[Location]
    imagePath: str | None


@dataclass(frozen=True, slots=True)
class ParseOptions:
    """影响结果内容的冻结配置；任何一项变化都必须换 parserFingerprint。

    `ocr_mode` 是 MinerU 真实存在的选项（`parse(ocr_mode=...)`）：auto 按页判断，txt 只走文本层，
    ocr 强制识别。不列出 `language`：MinerU 4.x 的 SDK 没有语言参数，记录它会让指纹声称一个
    不影响输出的值。
    """

    tier: str
    small_backend: str
    vlm_engine: str
    device: str
    page_range: str
    ocr_mode: str


@dataclass(frozen=True, slots=True)
class DocumentRequest:
    operation: str
    project_root: Path
    source: Path
    output: Path
    models: Path | None
    options: ParseOptions


def absolute_path(value: object, *, must_exist: bool) -> Path:
    if not isinstance(value, str) or not value or not Path(value).is_absolute():
        raise ValueError("research_absolute_path_required")
    path = Path(value)
    if path.is_symlink():
        raise ValueError("research_path_symlink")
    return path.resolve(strict=must_exist)


def within(root: Path, value: object, *, must_exist: bool) -> Path:
    path = absolute_path(value, must_exist=must_exist)
    if path == root or not path.is_relative_to(root):
        raise ValueError("research_path_outside_project")
    return path


def read_options(value: object) -> ParseOptions:
    if not isinstance(value, dict):
        raise ValueError("research_request_invalid")
    expected = {"tier", "smallBackend", "vlmEngine", "device", "pageRange", "ocrMode"}
    if set(value) != expected:
        raise ValueError("research_request_fields_invalid")
    tier = value["tier"]
    if tier not in TIERS:
        raise ValueError("research_tier_unsupported")
    small_backend = value["smallBackend"]
    # 只接受 torch：auto 在沙箱内 MPS 不可见时会静默切到 ONNX 并要求未下载的仓库。
    if small_backend != "torch":
        raise ValueError("research_small_backend_unsupported")
    text = {key: value[key] for key in ("vlmEngine", "device", "pageRange", "ocrMode")}
    if not all(isinstance(item, str) for item in text.values()):
        raise ValueError("research_request_fields_invalid")
    if len(text["pageRange"]) > 64:
        raise ValueError("research_request_fields_invalid")
    if text["ocrMode"] not in OCR_MODES:
        raise ValueError("research_ocr_mode_unsupported")
    vlm_engine = text["vlmEngine"]
    # 非 VLM 档位不可登记任何引擎选择，只能 `auto`（不指定）。
    if tier in VLM_TIERS:
        if vlm_engine not in VLM_ENGINES:
            raise ValueError("research_vlm_engine_unsupported")
    elif vlm_engine != "auto":
        raise ValueError("research_vlm_engine_unsupported")
    if text["device"] not in DEVICES:
        raise ValueError("research_device_unsupported")
    return ParseOptions(tier, small_backend, vlm_engine, text["device"], text["pageRange"], text["ocrMode"])


def parse_request(value: object) -> DocumentRequest:
    if not isinstance(value, dict):
        raise ValueError("research_request_invalid")
    if value.get("operation") != "parse_document":
        raise ValueError("research_operation_unknown")
    if set(value) != {"operation", "projectRoot", "sourcePath", "outputDir", "modelsPath", "options"}:
        raise ValueError("research_request_fields_invalid")
    root = absolute_path(value["projectRoot"], must_exist=True)
    if not root.is_dir():
        raise ValueError("research_project_directory_required")
    source = within(root, value["sourcePath"], must_exist=True)
    if not source.is_file():
        raise ValueError("research_source_file_required")
    if source.stat().st_size > MAX_SOURCE_BYTES:
        raise ValueError("research_source_too_large")
    output = within(root, value["outputDir"], must_exist=False)
    if output.exists():
        raise ValueError("research_output_already_exists")
    if source.suffix.lower() not in SUPPORTED_SUFFIXES:
        raise ValueError("research_source_format_unsupported")
    options = read_options(value["options"])
    models_value = value.get("modelsPath")
    # Flash 不加载推理模型，其余档位必须有已校验的模型目录。
    if options.tier == "flash":
        if models_value is None:
            models = None
        else:
            models = absolute_path(models_value, must_exist=True)
            if not models.is_dir():
                raise ValueError("research_models_directory_required")
    else:
        if models_value is None:
            raise ValueError("research_models_directory_required")
        models = absolute_path(models_value, must_exist=True)
        if not models.is_dir():
            raise ValueError("research_models_directory_required")
    return DocumentRequest("parse_document", root, source, output, models, options)


def file_hash(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def validate_document_dimensions(source: Path) -> None:
    """预检只做校验，不生成任何替代解析结果。"""
    if source.suffix.lower() == ".pdf":
        import pypdfium2 as pdfium

        with pdfium.PdfDocument(source) as pdf:
            if len(pdf) > MAX_PAGES:
                raise ValueError("research_document_page_limit_exceeded")
            for number in range(len(pdf)):
                with contextlib.closing(pdf[number]) as page:
                    pixels = page.get_width() * page.get_height() * 1.5 ** 2
                    if not math.isfinite(pixels) or pixels <= 0 or pixels > MAX_PAGE_PIXELS:
                        raise ValueError("research_document_page_too_large")
    elif source.suffix.lower() not in {".html", ".htm"}:
        from PIL import Image

        with Image.open(source) as picture:
            if picture.width * picture.height > MAX_PAGE_PIXELS:
                raise ValueError("research_document_page_too_large")


def write_mineru_config(path: Path, models: Path | None, options: ParseOptions) -> None:
    """生成独立 MINERU_CONFIG：本地模型、固定 torch 后端、清空远端 VLM 连接。"""
    lines = [
        "model:",
        "  source: local",
        *([] if models is None else [f"  base_dir: {json.dumps(str(models))}"]),
        "  small_backend: torch",
        "  vlm:",
        f"    engine: {json.dumps(options.vlm_engine)}",
        '    server_url: ""',
        '    api_key: ""',
        '    model: ""',
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def ensure_device(options: ParseOptions) -> None:
    """MPS 不可用时显式报错，绝不静默降级到 CPU/ONNX。"""
    import torch

    if options.device != "mps":
        return
    if not torch.backends.mps.is_available():
        raise ValueError("research_runtime_device_unavailable")
    from mineru.model.runtime.device import get_device

    if get_device().split(":")[0] != "mps":
        raise ValueError("research_runtime_device_unavailable")


# ---------------------------------------------------------------- 结果适配

# MinerU 的语义标签 → Roc 的 block kind。无法映射的标签保留原文，避免无声丢失内容。
_HEADING_TYPES = {"doc_title", "paragraph_title", "title", "section_header"}
_TABLE_TYPES = {"table"}
_FIGURE_TYPES = {"image", "figure", "chart"}
_EQUATION_TYPES = {"equation", "formula", "interline_equation"}
# 这些标签只作为原始 label 保留，不当作正文（脚注、页眉页脚、页码、旁注）。
_NON_BODY_TYPES = {"page_footnote", "footer", "page_number", "aside_text", "header"}


def block_kind(block_type: str) -> str:
    if block_type in _TABLE_TYPES:
        return "table"
    if block_type in _FIGURE_TYPES:
        return "figure"
    if block_type in _EQUATION_TYPES:
        return "formula"
    if block_type in _HEADING_TYPES:
        return "heading"
    return "paragraph"


def collect_text(node: Any) -> str:
    """按顺序拼接 MinerU content 树里的文本叶子。"""
    if isinstance(node, str):
        return node
    if isinstance(node, list):
        return "".join(collect_text(item) for item in node)
    if not isinstance(node, dict):
        return ""
    inner = node.get("content")
    if isinstance(inner, str):
        return inner
    return collect_text(inner)


def block_text(block: dict[str, Any]) -> str:
    block_type = str(block.get("type") or "")
    if block_type in _TABLE_TYPES:
        # 表格保留原始 HTML 结构，业务侧再转 Markdown。
        return collect_text(block.get("content")).strip()
    content = block.get("content")
    if not isinstance(content, list):
        return collect_text(content).strip()
    if block_type in _FIGURE_TYPES:
        # 图稿只取说明文字；图片本体走 image_path 资产。
        parts = [collect_text(item) for item in content
                 if isinstance(item, dict) and item.get("type") in {"image_caption", "caption", "text"}]
        return " ".join(part.strip() for part in parts if part.strip())
    if block_type in _EQUATION_TYPES:
        parts = [collect_text(item) for item in content
                 if isinstance(item, dict) and item.get("type") in {"text", "equation", "latex"}]
        return " ".join(part.strip() for part in parts if part.strip())
    return collect_text(content).strip()


def block_image_path(block: dict[str, Any]) -> str | None:
    """只使用 MinerU 记录的真实资产路径，不拼猜文件名。

    路径位置随块类型不同：图稿在 `content[].image_path`（image_body），
    行间公式则直接在块顶层的 `image_path`。两处都读，才拿得到全部图稿。
    """
    candidates: list[Any] = [block.get("image_path"), block.get("image_source")]
    content = block.get("content")
    if isinstance(content, list):
        candidates.extend(item.get("image_path") for item in content if isinstance(item, dict))
    for candidate in candidates:
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return None


def page_bbox(block: dict[str, Any]) -> list[float] | None:
    """MinerU 的 bbox 是页面归一化坐标（0-1，TOPLEFT 原点）。"""
    bbox = block.get("bbox")
    if not isinstance(bbox, list) or len(bbox) != 4:
        return None
    try:
        values = [float(item) for item in bbox]
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(item) for item in values):
        return None
    return values


def adapt(middle_json: dict[str, Any], options: ParseOptions) -> dict[str, Any]:
    pages = middle_json.get("pages")
    if not isinstance(pages, list) or not pages:
        raise ValueError("research_document_output_invalid")
    blocks: list[Block] = []
    assets: list[dict[str, Any]] = []
    warnings: list[str] = []
    seen_assets: set[str] = set()
    page_count = 0

    for page in pages:
        if not isinstance(page, dict):
            raise ValueError("research_document_output_invalid")
        page_index = page.get("page_idx")
        if not isinstance(page_index, int) or page_index < 0:
            raise ValueError("research_document_output_invalid")
        # MinerU 的 page_idx 从 0 开始；Roc 页码从 1 开始，且不能用过滤后的位置重新编号。
        page_count = max(page_count, page_index + 1)
        page_blocks = page.get("blocks")
        if not isinstance(page_blocks, list):
            raise ValueError("research_document_output_invalid")
        for raw in page_blocks:
            if not isinstance(raw, dict):
                raise ValueError("research_document_output_invalid")
            block_type = str(raw.get("type") or "text")
            text = block_text(raw)
            image_path = block_image_path(raw)
            kind = block_kind(block_type)
            if image_path is not None and image_path not in seen_assets:
                seen_assets.add(image_path)
                assets.append({"path": image_path, "kind": kind if kind in {"figure", "table", "formula"} else "figure",
                               "page": page_index + 1})
            if block_type in _NON_BODY_TYPES and not text:
                continue
            bbox = page_bbox(raw)
            locations: list[Location] = [] if bbox is None else [
                {"page": page_index + 1, "bbox": bbox, "coordinateOrigin": "TOPLEFT"}
            ]
            locator = f"page {page_index + 1}" + ("" if bbox is None else f"; bbox {bbox}")
            blocks.append({
                "id": f"p{page_index + 1}-b{raw.get('index', len(blocks))}",
                "kind": kind,
                "label": block_type,
                "text": text,
                "locator": locator,
                "locations": locations,
                "imagePath": image_path,
            })

    content = "\n\n".join(block["text"] for block in blocks if block["text"].strip())
    if not content:
        # 合法空白文档给出显式诊断，但不得标记为完整成功。
        warnings.append("no_searchable_text")
    if page_count == 0:
        raise ValueError("research_document_output_invalid")
    return {"pageCount": page_count, "content": content, "blocks": blocks,
            "assets": assets, "warnings": warnings}


def normalize_assets(output: Path, assets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """把素材转成 PNG 供业务消费，原始文件留在 artifacts 供追溯。

    MinerU 外置的图片是 JPEG。业务侧统一按 PNG 校验与预览，所以这里另写一份
    `normalized/` 副本并改写引用；原图不被修改，仍可按原始路径追溯。
    """
    from PIL import Image

    normalized_root = output / "normalized"
    result: list[dict[str, Any]] = []
    for asset in assets:
        source = (output / asset["path"]).resolve()
        if not source.is_file():
            # 引用存在但文件缺失：直接失败，不留“看起来成功”的结果。
            raise ValueError("research_document_asset_missing")
        target = normalized_root / f"{asset['path'].replace('/', '_')}.png"
        target.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(source) as picture:
            # 保留透明通道的同时统一为 PNG，避免 JPEG 二次压缩损失。
            picture.convert("RGBA" if picture.mode in {"RGBA", "LA", "P"} else "RGB").save(target, format="PNG")
        result.append({**asset, "path": target.relative_to(output).as_posix(), "originalPath": asset["path"]})
    return result


def runtime_identity(options: ParseOptions) -> dict[str, str]:
    """记录实际参与本次解析的运行库与设备。

    只列真正影响输出的包：把没用到的库写进指纹会让无关升级也误报缓存失效。
    """
    import platform

    import torch
    identity = {
        "python": platform.python_version(),
        "platform": platform.platform(),
        "machine": platform.machine(),
        "torch": torch.__version__,
    }
    try:
        identity["transformers"] = importlib.metadata.version("transformers")
    except importlib.metadata.PackageNotFoundError:
        pass
    if options.tier in VLM_TIERS:
        try:
            identity["llamaCpp"] = importlib.metadata.version("mineru-llama-cpp")
        except importlib.metadata.PackageNotFoundError:
            pass
    return identity


def parser_fingerprint(options: ParseOptions, mineru_version: str, adapter_version: str,
                       model_manifest: str, runtime: dict[str, str]) -> str:
    payload = {
        "engine": "mineru", "engineVersion": mineru_version, "adapterVersion": adapter_version,
        "tier": options.tier, "smallBackend": options.small_backend, "vlmEngine": options.vlm_engine,
        "device": options.device, "pageRange": options.page_range, "ocrMode": options.ocr_mode,
        "modelManifest": model_manifest, "runtime": runtime,
    }
    normalized = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


ADAPTER_VERSION = "roc-mineru-1"
# 与 `src/shared/schemas/research-production.ts` 的 `researchParseContractVersion` 必须一致。
CONTRACT_VERSION = 2


def parse_document(request: DocumentRequest) -> dict[str, Any]:
    validate_document_dimensions(request.source)
    source, output, models, options = request.source, request.output, request.models, request.options

    # 独立 MINERU_HOME / MINERU_CONFIG：不继承用户 ~/.mineru 或代理配置。
    home = output / ".mineru-home"
    home.mkdir(parents=True, exist_ok=True)
    os.environ["MINERU_HOME"] = str(home)
    config_path = output / ".mineru-config.yaml"
    write_mineru_config(config_path, models, options)
    os.environ["MINERU_CONFIG"] = str(config_path)

    ensure_device(options)

    from mineru.parser import parse
    from mineru.parser.writer import FileBasedDataWriter

    result = parse(
        source,
        tier=options.tier,
        ocr_mode=options.ocr_mode,
        page_range=options.page_range,
    )
    artifacts = output / "artifacts"
    artifacts.mkdir(parents=True, exist_ok=True)
    # 先完整物化素材，再适配：只有 to_json 不代表已拿到所有图稿。
    result.save(FileBasedDataWriter(str(artifacts)))

    middle_json = json.loads((artifacts / "middle_json.json").read_text(encoding="utf-8"))
    adapted = adapt(middle_json, options)
    adapted["assets"] = normalize_assets(artifacts, adapted["assets"])
    # 块引用的 imagePath 也要指向规范化后的 PNG，否则业务侧索引不到素材。
    renamed = {asset["originalPath"]: asset["path"] for asset in adapted["assets"]}
    adapted["blocks"] = [
        {**block, "imagePath": None if block["imagePath"] is None else renamed.get(block["imagePath"], block["imagePath"])}
        for block in adapted["blocks"]
    ]
    mineru_version = importlib.metadata.version("mineru")
    runtime = runtime_identity(options)
    # Flash 无模型目录：用空串表示"无模型参与"，而不是一个假摘要。
    manifest = "" if models is None else hashlib.sha256(json.dumps(sorted(
        (entry.relative_to(models).as_posix(), entry.stat().st_size)
        for entry in models.rglob("*")
        if entry.is_file() and ".locks" not in entry.parts and entry.name != ".mineru_complete"
    ), ensure_ascii=False).encode("utf-8")).hexdigest()
    fingerprint = parser_fingerprint(options, mineru_version, ADAPTER_VERSION, manifest, runtime)

    actual_tier = ((middle_json.get("extensions") or {}).get("mineru") or {}).get("tier", options.tier)
    actual_mode = ((middle_json.get("extensions") or {}).get("mineru") or {}).get("parse_mode")
    return {
        **adapted,
        "contractVersion": CONTRACT_VERSION,
        "engine": "mineru",
        "engineVersion": mineru_version,
        "adapterVersion": ADAPTER_VERSION,
        "parserVersion": f"mineru:{mineru_version}",
        "parserFingerprint": fingerprint,
        "modelManifest": manifest,
        "runtime": runtime,
        "tier": options.tier,
        "parseMode": actual_mode if isinstance(actual_mode, str) else None,
        "reportedTier": actual_tier if isinstance(actual_tier, str) else options.tier,
        "device": options.device,
        "artifacts": {
            "middleJson": "artifacts/middle_json.json",
            "markdown": "artifacts/markdown.md",
            "structuredContent": "artifacts/structured_content.json",
        },
    }


def execute(request: DocumentRequest) -> dict[str, Any]:
    before = file_hash(request.source)
    request.output.mkdir(parents=True, exist_ok=False)
    try:
        result = parse_document(request)
        if file_hash(request.source) != before:
            raise ValueError("research_source_changed_during_parse")
        return {**result, "sourceHash": before}
    except BaseException:
        shutil.rmtree(request.output, ignore_errors=True)
        raise


def main() -> None:
    try:
        raw = sys.stdin.buffer.read(65537)
        if len(raw) > 65536:
            raise ValueError("research_request_too_large")
        request = parse_request(json.loads(raw))
        with contextlib.redirect_stdout(sys.stderr):
            result = execute(request)
        json.dump({"ok": True, "result": result}, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
    except Exception as error:
        traceback.print_exception(error, file=sys.stderr)
        code = str(error) if isinstance(error, ValueError) and str(error).startswith("research_") else "research_runtime_failed"
        json.dump({"ok": False, "error": {"code": code, "type": type(error).__name__}}, sys.stdout)
        sys.stdout.write("\n")
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
