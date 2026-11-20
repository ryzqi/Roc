"""Export unchanged SciEGQA benchmark sources and published evidence regions.

Read only bounded regular archive members. Preserve every original question;
invalid/missing regions remain explicit and never become unanswerable labels.
--verify reconstructs all outputs from the locked original release.
"""
import argparse
import hashlib
import importlib.util
import json
import math
import os
import re
import struct
import tarfile
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location(
    "sciegqa_sources", ROOT / "scripts/prepare-scientific-sciegqa-sources.py")
sources = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sources)
DOMAINS = ("cs", "econ", "eess", "math", "physics", "q-bio", "q-fin", "stat")
DOMAIN = "(?:" + "|".join(DOMAINS) + ")"
PDF_MEMBER = re.compile(rf"PDF/({DOMAIN})/(\d{{4}}\.\d{{4,5}})_.+\.pdf")
IMAGE_MEMBER = re.compile(rf"Images/({DOMAIN})/(\d{{4}}\.\d{{4,5}})/\2_([1-9]\d*)\.png")
METADATA_MEMBER = re.compile(rf"Images/({DOMAIN})/\.DS_Store")
MAX_MEMBER_BYTES = 64 * 1024**2
PIXEL_ROUNDING_TOLERANCE = 0.01


def digest(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode()


def lock_hash(lock):
    # Same canonicalization as evaluation/lib/common.mjs for this integer/string lock.
    return digest(json.dumps(lock, ensure_ascii=False, sort_keys=True,
                             separators=(",", ":"), allow_nan=False).encode())


def output_path(root, name):
    parts = name.split("/")
    if not parts or any(p in ("", ".", "..") for p in parts) or "\\" in name:
        raise ValueError("scientific_sciegqa_export_path_invalid")
    current = root
    for part in parts:
        current /= part
        if current.is_symlink():
            raise ValueError("scientific_sciegqa_export_path_invalid")
    return current


def publish(root, name, data, verify):
    path = output_path(root, name)
    if verify or path.exists():
        if not path.is_file() or path.stat().st_size != len(data) or path.read_bytes() != data:
            raise ValueError(f"scientific_sciegqa_export_changed:{name}")
    else:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with path.open("xb") as output:
            output.write(data)


def archive_members(archive):
    seen = set()
    total = 0
    for member in archive:
        parts = member.name.split("/")
        if (member.name in seen or any(p in ("", ".", "..") for p in parts)
                or "\\" in member.name or not (member.isdir() or member.isfile())
                or member.size < 0 or member.size > MAX_MEMBER_BYTES):
            raise ValueError("scientific_sciegqa_archive_member_invalid")
        seen.add(member.name)
        total += member.size
        if total > sources.MAX_BYTES or len(seen) > 10000:
            raise ValueError("scientific_sciegqa_archive_budget_exceeded")
        if member.isfile():
            yield member


def member_bytes(archive, member):
    with archive.extractfile(member) as source:
        data = source.read(member.size + 1)
    if len(data) != member.size:
        raise ValueError("scientific_sciegqa_archive_member_truncated")
    return data


def png_dimensions(data):
    if (len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n"
            or data[8:16] != b"\x00\x00\x00\rIHDR"):
        raise ValueError("scientific_sciegqa_image_invalid")
    width, height = struct.unpack(">II", data[16:24])
    if not width or not height or width * height > 100000000:
        raise ValueError("scientific_sciegqa_image_invalid")
    return width, height


def original_rows(source_root, lock):
    rows = [json.loads(line) for line in (source_root / "SciEGQA_Bench.jsonl")
            .read_text(encoding="utf-8").splitlines() if line.strip()]
    keys = {"query", "answer", "doc_name", "category", "evidence_page",
            "bbox", "rel_bbox", "subimg_type"}
    for row in rows:
        if (not isinstance(row, dict) or set(row) != keys or row["category"] not in DOMAINS
                or not isinstance(row["doc_name"], str)
                or not re.fullmatch(r"\d{4}\.\d{4,5}", row["doc_name"])
                or any(not isinstance(row[k], str) or not row[k].strip() for k in ("query", "answer"))
                or not isinstance(row["evidence_page"], list) or not row["evidence_page"]
                or any(type(p) is not int or p < 1 for p in row["evidence_page"])):
            raise ValueError("scientific_sciegqa_label_invalid")
        for key in ("bbox", "rel_bbox", "subimg_type"):
            if not isinstance(row[key], list) or len(row[key]) != len(row["evidence_page"]):
                raise ValueError("scientific_sciegqa_label_invalid")
        for boxes, relative, kinds in zip(row["bbox"], row["rel_bbox"], row["subimg_type"]):
            if (not isinstance(boxes, list) or not boxes or not isinstance(relative, list)
                    or not isinstance(kinds, list) or len(boxes) != len(relative) or len(boxes) != len(kinds)
                    or any(kind not in ("text", "image", "table") for kind in kinds)):
                raise ValueError("scientific_sciegqa_label_invalid")
            if any(not isinstance(box, list) or len(box) != 4
                   or any(type(n) not in (int, float) or not math.isfinite(n) for n in box)
                   for box in (*boxes, *relative)):
                raise ValueError("scientific_sciegqa_label_invalid")
    if (len(rows) != lock["expectedRows"]
            or len({(r["category"], r["doc_name"]) for r in rows}) != lock["expectedPapers"]):
        raise ValueError("scientific_sciegqa_label_count_changed")
    return rows


def prepare(source_root, output_root, verify=False, lock=None):
    lock = lock if lock is not None else json.loads(sources.LOCK.read_bytes())
    sources.prepare(source_root, offline=True, lock=lock)
    source_root = sources.checked_root(source_root)
    output_root = Path(os.path.abspath(output_root))
    if output_root == source_root or source_root in output_root.parents or output_root in source_root.parents:
        raise ValueError("scientific_sciegqa_export_overlaps_sources")
    output_root = sources.checked_root(output_root, create=not verify)
    rows = original_rows(source_root, lock)
    papers = {(row["category"], row["doc_name"]): {
        "id": f"sciegqa:{row['category']}:{row['doc_name']}",
        "domain": row["category"], "docName": row["doc_name"], "pdf": None, "images": [],
    } for row in rows}
    images = {}
    emitted = set()
    metadata = []
    for filename, pattern in (("PDF.tar", PDF_MEMBER), ("Images.tar", IMAGE_MEMBER)):
        with tarfile.open(source_root / filename, mode="r:") as archive:
            for member in archive_members(archive):
                match = pattern.fullmatch(member.name)
                if not match:
                    if filename == "Images.tar" and METADATA_MEMBER.fullmatch(member.name):
                        data = member_bytes(archive, member)
                        metadata.append({"archiveMember": member.name, "bytes": len(data), "sha256": digest(data)})
                        continue
                    raise ValueError(f"scientific_sciegqa_archive_member_unknown:{member.name}")
                domain, name = match.group(1, 2)
                paper = papers.get((domain, name))
                if not paper:
                    raise ValueError("scientific_sciegqa_archive_paper_unknown")
                data = member_bytes(archive, member)
                asset = {"archive": filename, "archiveMember": member.name,
                         "bytes": len(data), "sha256": digest(data)}
                if filename == "PDF.tar":
                    if paper["pdf"] is not None or not data.startswith(b"%PDF-"):
                        raise ValueError("scientific_sciegqa_pdf_invalid")
                    asset["path"] = f"pdfs/{domain}/{name}.pdf"
                    paper["pdf"] = asset
                else:
                    page = int(match.group(3))
                    width, height = png_dimensions(data)
                    asset.update({"path": f"images/{domain}/{name}/{name}_{page}.png",
                                  "page": page, "width": width, "height": height})
                    if (domain, name, page) in images:
                        raise ValueError("scientific_sciegqa_image_duplicate")
                    images[(domain, name, page)] = asset
                    paper["images"].append(asset)
                publish(output_root, asset["path"], data, verify)
                emitted.add(asset["path"])
    tasks = []
    for index, row in enumerate(rows):
        paper = papers[(row["category"], row["doc_name"])]
        evidence, issues = [], []
        if paper["pdf"] is None:
            issues.append("missing-original-pdf")
        if len(set(row["evidence_page"])) != len(row["evidence_page"]):
            issues.append("duplicate-published-evidence-page")
        for page_index, page in enumerate(row["evidence_page"]):
            image = images.get((row["category"], row["doc_name"], page))
            if image is None:
                issues.append(f"missing-evidence-image:{page}")
            for region_index, (box, relative, kind) in enumerate(zip(
                    row["bbox"][page_index], row["rel_bbox"][page_index], row["subimg_type"][page_index])):
                normalized = [n / 1000 for n in relative]
                if not (0 <= normalized[0] < normalized[2] <= 1
                        and 0 <= normalized[1] < normalized[3] <= 1):
                    issues.append(f"invalid-published-relative-region:{page}:{region_index}")
                if image:
                    w, h = image["width"], image["height"]
                    if not (0 <= box[0] < box[2] <= w and 0 <= box[1] < box[3] <= h):
                        issues.append(f"invalid-published-pixel-region:{page}:{region_index}")
                    if any(abs(a - n * d) > PIXEL_ROUNDING_TOLERANCE
                           for a, n, d in zip(box, normalized, (w, h, w, h))):
                        issues.append(f"published-coordinate-mismatch:{page}:{region_index}")
                evidence.append({
                    "id": f"sciegqa:test:{index}:page-group:{page_index}:page:{page}:region:{region_index}",
                    "page": page, "kind": kind, "pixelBbox": box, "normalizedBbox": normalized,
                    "pageImage": image, "pdfHash": paper["pdf"]["sha256"] if paper["pdf"] else None,
                    "coordinateSystem": "TOPLEFT_NORMALIZED", "granularity": "published-semantic-region",
                })
        tasks.append({
            "id": f"sciegqa:test:{index}", "publishedRow": index, "original": row,
            "paperId": paper["id"], "evidence": evidence,
            "status": "published-image-regions-verified" if not issues else "unqualified-published-region",
            "issues": issues, "originalPdfAlignment": "pending",
        })
    ordered_papers = [papers[key] for key in sorted(papers)]
    for paper in ordered_papers:
        paper["images"].sort(key=lambda asset: asset["page"])
    labels = json_bytes(tasks)
    manifest = {
        "schemaVersion": 1, "kind": "scientific-public-sciegqa-benchmark-export",
        "sourceRevision": lock["revision"],
        "sourceLockHash": lock_hash(lock), "sourceLockHashAlgorithm": "roc-json-sort-v1",
        "license": lock["license"],
        "annotationProvenance": lock["annotationProvenance"],
        "tasks": len(tasks), "labelsPath": "labels.json", "labelsHash": digest(labels),
        "papers": ordered_papers, "pageImages": len(images),
        "regions": sum(len(t["evidence"]) for t in tasks),
        "statuses": dict(sorted(Counter(t["status"] for t in tasks).items())),
        "domains": dict(sorted(Counter(t["original"]["category"] for t in tasks).items())),
        "regionKinds": dict(sorted(Counter(e["kind"] for t in tasks for e in t["evidence"]).items())),
        "retainedArchiveMetadata": sorted(metadata, key=lambda item: item["archiveMember"]),
        "exporterHash": digest(Path(__file__).read_bytes()), "scientificBaselineReady": False,
        "limitations": [
            "Published human semantic-region gold; no fabricated local reviewer IDs.",
            "Pixel/0..1000 coordinates checked against original PNG dimensions.",
            "Full PDF/PNG correspondence remains a separate independent check.",
            "No per-glyph transcript, LaTeX, cell-structure or complete Wiki fact gold.",
            "ArXiv domains are not the plan's paper-layout/query-category quotas.",
            "All rows retained; missing/invalid evidence is never a negative question.",
            "Archive .DS_Store metadata hashed, never exported as page images.",
        ],
    }
    publish(output_root, "labels.json", labels, verify)
    publish(output_root, "manifest.json", json_bytes(manifest), verify)
    emitted.update(("labels.json", "manifest.json"))
    actual = set()
    for path in output_root.rglob("*"):
        if path.is_symlink():
            raise ValueError("scientific_sciegqa_export_path_invalid")
        if path.is_file():
            actual.add(path.relative_to(output_root).as_posix())
    if actual != emitted:
        raise ValueError("scientific_sciegqa_export_inventory_changed")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=ROOT / "evaluation/local/sources/sciegqa-bench")
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    manifest = prepare(args.source_root, args.output_root, args.verify)
    print(json.dumps({key: manifest[key] for key in (
        "tasks", "pageImages", "regions", "statuses", "domains", "regionKinds",
        "labelsHash", "scientificBaselineReady")}, ensure_ascii=False, indent=2))
