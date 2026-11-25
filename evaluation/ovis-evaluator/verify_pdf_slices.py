#!/usr/bin/env python3
"""Audit frozen original PDF slices; automated evidence never certifies human review."""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import math
from pathlib import Path
import platform
import sys
import unicodedata

import numpy as np
from PIL import Image
import pymupdf
from skimage.metrics import structural_similarity
from skimage.registration import phase_cross_correlation

DPI = 200
DIAGNOSTIC_MAX_SIDE = 1024


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def checked(root: Path, record: dict) -> Path:
    path = (root / record["path"]).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError("asset path leaves source root")
    if path.stat().st_size != record["bytes"] or digest(path) != record["sha256"]:
        raise ValueError(f"asset identity changed: {path}")
    return path


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def normalize_text(value: str) -> str:
    return "".join(unicodedata.normalize("NFC", value).casefold().split())


def bigram_overlap(left: str, right: str) -> dict:
    a, b = normalize_text(left), normalize_text(right)
    x, y = {a[i:i + 2] for i in range(len(a) - 1)}, {b[i:i + 2] for i in range(len(b) - 1)}
    return {"nativeUniqueBigrams": len(x), "goldUniqueBigrams": len(y),
            "goldBigramCoverage": len(x & y) / len(y) if y else None}


def transforms(page: pymupdf.Page, raster_size: tuple[int, int], gold_size: tuple[int, int], render_origin: tuple[int, int] = (0, 0)) -> dict:
    """Column-vector convention: x'=a*x+c*y+e, y'=b*x+d*y+f."""
    rotation = page.rotation_matrix
    # PyMuPDF 1.26.7's matrix omits CropBox offsets on rotated pages.
    # Read the unrotated in-memory page matrix, then restore its rotation.
    degrees = page.rotation
    try:
        page.set_rotation(0)
        unrotated = page.transformation_matrix
    finally:
        page.set_rotation(degrees)
    pdf_to_page = unrotated * rotation
    # The renderer uses the exact DPI scale, then rounds the canvas outward.
    # The fractional page edge is not stretched to the integer pixel boundary.
    pixel_scale = pymupdf.Matrix(DPI / 72, DPI / 72)
    to_render = pdf_to_page * pixel_scale * pymupdf.Matrix(1, 0, 0, 1, -render_origin[0], -render_origin[1])
    to_gold = to_render * pymupdf.Matrix(gold_size[0] / raster_size[0], gold_size[1] / raster_size[1])
    to_normal = to_gold * pymupdf.Matrix(1 / gold_size[0], 1 / gold_size[1])
    inverse = ~to_normal
    corners = [pymupdf.Point(x, y) for x, y in [(0, 0), (1, 0), (1, 1), (0, 1)]]
    error = max(abs((point * inverse * to_normal) - point) for point in corners)
    if error > 1e-5:
        raise ValueError(f"coordinate round-trip failed: {error}")
    return {"coefficientConvention": "[a,b,c,d,e,f]; x'=a*x+c*y+e; y'=b*x+d*y+f",
            "pdfBottomLeftToMuPdfTopLeft": list(unrotated),
            "unrotatedToRotated": list(rotation), "pdfToRenderPixels": list(to_render),
            "renderPixelsToGoldImagePixels": [gold_size[0] / raster_size[0], 0, 0, gold_size[1] / raster_size[1], 0, 0],
            "pdfToGoldPixels": list(to_gold), "pdfToTopLeftNormalized": list(to_normal),
            "topLeftNormalizedToPdf": list(inverse), "roundTripMaxError": error,
            "associationStatus": "proposed-scale-mapping-requires-alignment-and-independent-review"}


def compare_images(render: Image.Image, upstream: Image.Image) -> dict:
    width, height = upstream.size
    factor = min(1, DIAGNOSTIC_MAX_SIDE / max(width, height))
    size = (max(8, round(width * factor)), max(8, round(height * factor)))
    a = np.asarray(render.convert("L").resize(size, Image.Resampling.LANCZOS))
    b = np.asarray(upstream.convert("L").resize(size, Image.Resampling.LANCZOS))
    shift, _, _ = phase_cross_correlation(255.0 - b.astype(float), 255.0 - a.astype(float), upsample_factor=10)
    ma, mb = a < 200, b < 200
    union = int(ma.sum()) + int(mb.sum())
    return {"diagnosticSize": list(size), "resampling": "Pillow-LANCZOS",
            "unshiftedSsim": float(structural_similarity(a, b, data_range=255)),
            "unshiftedForegroundDice": 2 * int((ma & mb).sum()) / union if union else 1.0,
            "estimatedTranslationGoldPixelsXY": [float(shift[1] / factor), float(shift[0] / factor)],
            "meanAbsoluteLuminanceDifference": float(np.abs(a.astype(float) - b).mean()),
            "aspectRelativeDifference": abs(render.width / render.height / (width / height) - 1),
            "interpretation": "alignment diagnostics only; no automatic gold qualification"}


def audit_page(item: dict, gold: dict, source_root: Path, files: dict, output: Path, index: int) -> dict:
    image_path = checked(source_root, files[item["imagePath"]])
    pdf_path = checked(source_root, files[item["originalPdf"]["path"]])
    page_id = f"slice-{index:03d}"
    folder = output / page_id
    folder.mkdir()
    with Image.open(image_path) as source_image, pymupdf.open(pdf_path) as doc:
        source_image.load()
        expected = (item["width"], item["height"])
        if source_image.size != expected or (gold["page_info"]["width"], gold["page_info"]["height"]) != expected:
            raise ValueError("image/selection/gold dimensions disagree")
        if doc.page_count != 1 or doc.is_encrypted:
            raise ValueError("expected one readable unencrypted original PDF slice")
        page = doc[0]
        if page.rect.width <= 0 or page.rect.height <= 0:
            raise ValueError("empty PDF crop")
        pix = page.get_pixmap(dpi=DPI, colorspace=pymupdf.csRGB, alpha=False, annots=True)
        render_path = folder / "render.png"
        pix.save(render_path)
        render = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        text = page.get_text("text", sort=False)
        text_path = folder / "native-text.txt"
        text_path.write_text(text, encoding="utf-8")
        annotation_issues = []
        normalized_regions = []
        for region in gold["layout_dets"]:
            poly = region.get("poly", [])
            if len(poly) != 8 or not all(isinstance(n, (float, int)) and math.isfinite(n) for n in poly):
                annotation_issues.append({"annoId": region["anno_id"], "issue": "invalid-polygon"})
                continue
            if any(value < 0 or value > expected[axis % 2] for axis, value in enumerate(poly)):
                annotation_issues.append({"annoId": region["anno_id"], "issue": "polygon-outside-image"})
            normalized_regions.append({"annoId": region["anno_id"], "category": region["category_type"],
                                       "ignore": region.get("ignore", False),
                                       "polygon": [n / expected[k % 2] for k, n in enumerate(poly)]})
        write_json(folder / "normalized-gold-regions.json", normalized_regions)
        metric = compare_images(render, source_image)
        record = {"id": page_id, "imagePath": item["imagePath"], "annotationImagePath": item["annotationImagePath"],
                  "upstreamPageNo": item["upstreamPageNo"], "pdfPath": item["originalPdf"]["path"],
                  "pdfSha256": files[item["originalPdf"]["path"]]["sha256"], "imageSha256": files[item["imagePath"]]["sha256"],
                  "pdfPageCount": doc.page_count, "pdfWasRepaired": doc.is_repaired, "metadata": doc.metadata,
                  "mediaBoxPdf": list(page.mediabox), "cropBoxMuPdf": list(page.cropbox),
                  "cropBoxPosition": list(page.cropbox_position), "rotation": page.rotation,
                  "visibleRect": list(page.rect), "renderDpi": DPI, "renderSize": [pix.width, pix.height],
                  "goldImageSize": list(expected), "renderSha256": digest(render_path),
                  "nativeText": {"characters": len(text), "nonWhitespaceCharacters": len("".join(text.split())),
                                 "replacementCharacters": text.count("\ufffd"), "sha256": digest(text_path),
                                 "hasExtractableText": bool(text.strip()),
                                 **bigram_overlap(text, " ".join(r.get("text", "") for r in gold["layout_dets"] if not r.get("ignore")))},
                  "coordinateTransform": transforms(page, (pix.width, pix.height), expected, (pix.x, pix.y)),
                  "imageComparison": metric, "annotationIssues": annotation_issues,
                  "independentReview": "not_performed", "originalDocumentIdentity": None,
                  "crossPageGold": "not_established"}
        write_json(folder / "report.json", record)
        return record


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    repo, output = args.repo.resolve(), args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    lock_path = repo / "evaluation/corpora/ovis-ocr/sources.lock.json"
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    selection_path = repo / lock["selection"]["path"]
    if digest(selection_path) != lock["selection"]["sha256"]:
        raise ValueError("selection identity changed")
    selection = json.loads(selection_path.read_text(encoding="utf-8"))
    source_root = repo / lock["localSourceRoot"]
    gold_path = checked(source_root, lock["derivedGold"])
    gold = {p["page_info"]["image_path"]: p for p in json.loads(gold_path.read_text(encoding="utf-8"))}
    files = {f["path"]: f for f in lock["files"]}
    items = [p for p in selection["pages"] if p["originalPdf"] is not None]
    if len(items) != 210 or len(gold) != 347:
        raise ValueError("frozen corpus denominator changed")
    records, failures = [], []
    for i, item in enumerate(items, 1):
        try:
            record = audit_page(item, gold[item["annotationImagePath"]], source_root, files, output, i)
            records.append(record)
            print(json.dumps({"index": i, "id": record["id"], "ssim": record["imageComparison"]["unshiftedSsim"],
                              "nativeCharacters": record["nativeText"]["nonWhitespaceCharacters"]}), flush=True)
        except Exception as error:
            failures.append({"index": i, "imagePath": item["imagePath"], "error": f"{type(error).__name__}: {error}"})
            print(json.dumps(failures[-1]), flush=True)
    report = {"schemaVersion": 1, "status": "audited-requires-independent-review" if not failures else "invalid-incomplete",
              "sourceLockSha256": digest(lock_path), "selectionSha256": digest(selection_path),
              "goldSha256": digest(gold_path), "scriptSha256": digest(Path(__file__)),
              "runtime": {"python": sys.version, "platform": platform.platform(),
                          "packages": {n: importlib.metadata.version(n) for n in ["PyMuPDF", "Pillow", "numpy", "scikit-image"]}},
              "expectedPages": 210, "processedPages": len(records), "failures": failures,
              "pagesWithExtractableText": sum(r["nativeText"]["hasExtractableText"] for r in records),
              "pagesWithAnnotationIssues": sum(bool(r["annotationIssues"]) for r in records),
              "independentReviewerCount": 0, "scientificGoldQualified": False, "records": records}
    write_json(output / "report.json", report)
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
