"""Roc 科研工具的 JSON 进程边界。"""

from __future__ import annotations

import contextlib
from dataclasses import dataclass
import hashlib
import importlib.metadata
import json
import math
import mimetypes
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import sys
import traceback
from typing import TypedDict
import unicodedata
import zipfile

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
# Docling 注册类型时只使用随解释器提供的表，不读取主机 MIME 配置。
mimetypes.knownfiles = []
mimetypes.init(files=[])
MAX_PAGE_PIXELS = 25_000_000
# 附属模块只从已校验的运行时目录加载，不加入项目目录。
sys.path.insert(0, str(Path(__file__).resolve().parent))


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
class DocumentRequest:
    operation: str
    project_root: Path
    source: Path
    output: Path
    models: Path | None = None
    page: int | None = None
    scale: float | None = None
    bibliography_format: str | None = None


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


def parse_request(value: object) -> DocumentRequest:
    if not isinstance(value, dict):
        raise ValueError("research_request_invalid")
    operation = value.get("operation")
    fields = {"operation", "projectRoot", "sourcePath", "outputDir"}
    if operation == "parse_document":
        fields.add("modelsPath")
    elif operation == "render_pdf":
        fields.update({"page", "scale"})
    elif operation in {"read_bibliography", "write_bibliography"}:
        fields.add("format")
    elif operation not in {"extract_template", "normalize_bibliography"}:
        raise ValueError("research_operation_unknown")
    if set(value) != fields:
        raise ValueError("research_request_fields_invalid")
    root = absolute_path(value["projectRoot"], must_exist=True)
    if not root.is_dir():
        raise ValueError("research_project_directory_required")
    source = within(root, value["sourcePath"], must_exist=True)
    if not source.is_file():
        raise ValueError("research_source_file_required")
    if source.stat().st_size > 512 * 1024 * 1024:
        raise ValueError("research_source_too_large")
    output = within(root, value["outputDir"], must_exist=False)
    if output.exists():
        raise ValueError("research_output_already_exists")
    if operation in {"read_bibliography", "write_bibliography"}:
        format_name = value["format"]
        if not isinstance(format_name, str) or format_name not in {"bibtex", "biblatex", "csl-json"}:
            raise ValueError("research_bibliography_format_invalid")
        return DocumentRequest(operation, root, source, output, bibliography_format=format_name)
    if operation == "normalize_bibliography":
        return DocumentRequest(operation, root, source, output)
    if operation == "extract_template":
        if source.suffix.lower() != ".zip":
            raise ValueError("research_template_zip_required")
        return DocumentRequest(operation, root, source, output)
    if operation == "parse_document":
        if source.suffix.lower() not in {".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp", ".html", ".htm"}:
            raise ValueError("research_source_format_unsupported")
        models = absolute_path(value["modelsPath"], must_exist=True)
        if not models.is_dir():
            raise ValueError("research_models_directory_required")
        return DocumentRequest(operation, root, source, output, models=models)
    page, scale = value["page"], value["scale"]
    if type(page) is not int or page < 1 or type(scale) not in {float, int} or not 0.5 <= scale <= 4:
        raise ValueError("research_pdf_render_options_invalid")
    if source.suffix.lower() != ".pdf":
        raise ValueError("research_pdf_source_required")
    return DocumentRequest(operation, root, source, output, page=page, scale=float(scale))


def file_hash(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def extract_template(request: DocumentRequest) -> dict:
    with zipfile.ZipFile(request.source) as archive:
        members = archive.infolist()
        if len(members) > 5000 or sum(member.file_size for member in members) > 256 * 1024 * 1024:
            raise ValueError("research_template_archive_too_large")
        names: dict[str, str] = {}
        files: set[str] = set()
        for member in members:
            name = member.orig_filename
            path = PurePosixPath(name)
            mode = member.external_attr >> 16
            if (path.is_absolute() or not path.parts or ".." in path.parts or "\\" in name
                    or any(ord(char) < 32 for char in name) or stat.S_ISLNK(mode)
                    or stat.S_IFMT(mode) not in {0, stat.S_IFDIR, stat.S_IFREG} or member.flag_bits & 1):
                raise ValueError("research_template_archive_entry_invalid")
            if member.file_size > 64 * 1024 * 1024:
                raise ValueError("research_template_archive_too_large")
            for index in range(1, len(path.parts) + 1):
                part = PurePosixPath(*path.parts[:index]).as_posix()
                folded = unicodedata.normalize("NFC", part).casefold()
                if folded in names and names[folded] != part:
                    raise ValueError("research_template_archive_path_collision")
                names[folded] = part
            if not member.is_dir():
                if path.as_posix() in files:
                    raise ValueError("research_template_archive_path_collision")
                files.add(path.as_posix())
        extracted = 0
        for member in members:
            path = PurePosixPath(member.filename)
            if any(part in {"__MACOSX", ".git", ".DS_Store", ".roc-research", ".roc-build"} for part in path.parts):
                continue
            target = request.output.joinpath(*path.parts)
            if member.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(member) as source, target.open("xb") as destination:
                    shutil.copyfileobj(source, destination)
                extracted += 1
        return {"fileCount": extracted}


def render_pdf(request: DocumentRequest) -> dict:
    import pypdfium2 as pdfium

    source, output = request.source, request.output
    page_number, scale = request.page, request.scale
    if page_number is None or scale is None:
        raise ValueError("research_pdf_render_options_invalid")
    with pdfium.PdfDocument(source) as pdf:
        if page_number > len(pdf):
            raise ValueError("research_pdf_page_out_of_range")
        with contextlib.closing(pdf[page_number - 1]) as page:
            pixels = page.get_width() * page.get_height() * scale * scale
            if not math.isfinite(pixels) or pixels <= 0 or pixels > MAX_PAGE_PIXELS:
                raise ValueError("research_pdf_page_too_large")
            target = output / f"page-{page_number}.png"
            with contextlib.closing(page.render(scale=scale)) as bitmap, bitmap.to_pil() as image:
                image.save(target)
                width, height = image.size
            with contextlib.closing(page.get_textpage()) as text_page:
                text = text_page.get_text_bounded().replace("\r\n", "\n")
        return {"path": str(target), "page": page_number, "pageCount": len(pdf), "width": width, "height": height, "text": text}


def validate_document_dimensions(source: Path) -> None:
    if source.suffix.lower() == ".pdf":
        import pypdfium2 as pdfium

        with pdfium.PdfDocument(source) as pdf:
            if len(pdf) > 1000:
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


def parse_document(request: DocumentRequest) -> dict:
    validate_document_dimensions(request.source)
    from docling.backend.pypdfium2_backend import PyPdfiumDocumentBackend
    from docling.datamodel.accelerator_options import AcceleratorDevice, AcceleratorOptions
    from docling.datamodel.base_models import ConversionStatus, InputFormat
    from docling.datamodel.pipeline_options import OcrMacOptions, PdfPipelineOptions
    from docling.document_converter import DocumentConverter, ImageFormatOption, PdfFormatOption
    from docling_core.types.doc import PictureItem, TableItem, TextItem

    source, output, models = request.source, request.output, request.models
    if models is None:
        raise ValueError("research_models_directory_required")
    options = PdfPipelineOptions(
        artifacts_path=models,
        enable_remote_services=False,
        do_ocr=True,
        ocr_options=OcrMacOptions(lang=["zh-Hans", "en-US"], recognition="accurate", framework="vision"),
        do_table_structure=True,
        do_formula_enrichment=True,
        generate_page_images=True,
        generate_picture_images=True,
        images_scale=1.5,
        accelerator_options=AcceleratorOptions(device=AcceleratorDevice.CPU, num_threads=4),
    )
    converter = DocumentConverter(
        allowed_formats=[InputFormat.PDF, InputFormat.IMAGE, InputFormat.HTML],
        format_options={
            InputFormat.PDF: PdfFormatOption(backend=PyPdfiumDocumentBackend, pipeline_options=options),
            InputFormat.IMAGE: ImageFormatOption(pipeline_options=options),
        },
    )
    converted = converter.convert(source, max_num_pages=1000, max_file_size=512 * 1024 * 1024)
    if converted.status != ConversionStatus.SUCCESS:
        raise ValueError("research_document_conversion_incomplete")
    document = converted.document
    blocks: list[Block] = []
    assets: list[dict] = []
    warnings: list[str] = []
    for page_number, page in document.pages.items():
        if page.image is None:
            continue
        filename = f"page-{page_number}.png"
        page.image.pil_image.save(output / filename)
        assets.append({"path": filename, "kind": "page", "page": page_number})
    for item, _ in document.iterate_items():
        image_path: str | None = None
        if isinstance(item, TableItem):
            kind = "table"
            text = item.export_to_markdown(doc=document)
        elif isinstance(item, PictureItem):
            kind = "figure"
            text = item.caption_text(document)
        elif isinstance(item, TextItem):
            kind = "formula" if item.label.value == "formula" else "heading" if item.label.value == "section_header" else "paragraph"
            text = item.text
        else:
            continue
        if isinstance(item, (TableItem, PictureItem)):
            picture = item.get_image(document)
            if picture is not None:
                image_path = f"{kind}-{len(blocks)}.png"
                picture.save(output / image_path)
                assets.append({"path": image_path, "kind": kind, "page": item.prov[0].page_no if item.prov else None})
            else:
                warnings.append(f"picture_image_unavailable:{item.self_ref}")
        locations: list[Location] = [
            {"page": provenance.page_no, "bbox": [provenance.bbox.l, provenance.bbox.t, provenance.bbox.r, provenance.bbox.b],
             "coordinateOrigin": provenance.bbox.coord_origin.value}
            for provenance in item.prov
        ]
        pages = sorted({location["page"] for location in locations})
        locator = f"pages {','.join(map(str, pages))}; {item.self_ref}" if pages else f"node {item.self_ref}"
        blocks.append({"id": item.self_ref, "kind": kind, "label": item.label.value, "text": text,
                       "locator": locator, "locations": locations, "imagePath": image_path})
    content = "\n\n".join(block["text"] for block in blocks if block["text"].strip())
    if not content:
        warnings.append("no_searchable_text")
    result = {"parserVersion": importlib.metadata.version("docling"), "pageCount": len(document.pages),
              "content": content, "blocks": blocks, "assets": assets, "warnings": warnings}
    (output / "document.json").write_text(json.dumps(document.export_to_dict(), ensure_ascii=False), encoding="utf-8")
    return result


def execute(request: DocumentRequest) -> dict:
    before = file_hash(request.source)
    request.output.mkdir(parents=True, exist_ok=False)
    try:
        if request.operation in {"read_bibliography", "write_bibliography", "normalize_bibliography"}:
            from bibliography import normalize_file, read_file, write_file

            if request.operation == "normalize_bibliography":
                result = normalize_file(request.source)
            elif request.bibliography_format is None:
                raise ValueError("research_bibliography_format_required")
            else:
                result = (read_file(request.source, request.bibliography_format) if request.operation == "read_bibliography"
                          else write_file(request.source, request.output, request.bibliography_format))
        else:
            operation = {"parse_document": parse_document, "render_pdf": render_pdf, "extract_template": extract_template}[request.operation]
            result = operation(request)
        if file_hash(request.source) != before:
            raise ValueError("research_source_changed_during_parse")
        return {**result, "sourceHash": before}
    except BaseException:
        shutil.rmtree(request.output)
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
