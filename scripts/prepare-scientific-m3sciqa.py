# /// script
# requires-python = ">=3.12"
# dependencies = ["pyarrow==26.0.1"]
# ///
"""Export locked M3SciQA validation labels and unchanged embedded images.

No remote dataset code, model labels, reviewer fabrication or PDF bbox mapping.
--verify reconstructs the export from the pinned original Parquet.
"""
import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path

import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parent.parent
LOCK = ROOT / "evaluation/corpora/scientific-rag/expert-sources.lock.json"
TEXT_COLUMNS = (
    "question", "answer", "anchor_arxiv_id", "reference_arxiv_id", "modal",
    "anchor_reasoning_type", "reference_reasoning_type", "question_anchor",
    "answer_anchor", "question_reference", "explanation_reference", "evidence_reference",
)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode()


def bounded_path(root, name):
    parts = Path(name).parts
    if not parts or Path(name).is_absolute() or any(part in (".", "..") for part in parts):
        raise ValueError("scientific_m3_path_invalid")
    root = Path(root)
    if root.is_symlink():
        raise ValueError("scientific_m3_path_invalid")
    current = root
    for part in parts:
        current /= part
        if current.is_symlink():
            raise ValueError("scientific_m3_path_invalid")
    if not current.resolve().is_relative_to(root.resolve()):
        raise ValueError("scientific_m3_path_invalid")
    return current


def original_export(source_root):
    lock = json.loads(LOCK.read_bytes())
    source = next(row for row in lock["sources"] if row["id"] == "m3sciqa")
    for pin in source["files"]:
        data = bounded_path(source_root, pin["path"]).read_bytes()
        if len(data) != pin["bytes"] or digest(data) != pin["sha256"]:
            raise ValueError("scientific_m3_source_changed")
    pin = next(pin for pin in source["files"] if pin["path"].endswith(".parquet"))
    table = pq.read_table(bounded_path(source_root, pin["path"]))
    if set(table.column_names) != {*TEXT_COLUMNS, "figure"} or table.num_rows != source["expectedRows"]:
        raise ValueError("scientific_m3_schema_changed")
    tasks, assets = [], {}
    for index, row in enumerate(table.to_pylist()):
        if any(not isinstance(row[key], str) for key in TEXT_COLUMNS) or row["modal"] not in ("table", "figure"):
            raise ValueError("scientific_m3_label_invalid")
        if any(not row[key].strip() for key in TEXT_COLUMNS if key != "evidence_reference"):
            raise ValueError("scientific_m3_required_label_missing")
        image = row["figure"]["bytes"]
        if image.startswith(b"\x89PNG\r\n\x1a\n"):
            extension = "png"
        elif image.startswith(b"\xff\xd8\xff"):
            extension = "jpg"
        else:
            raise ValueError("scientific_m3_image_unsupported")
        name = f"images/{digest(image)}.{extension}"
        assets[name] = image
        tasks.append({
            "id": f"m3sciqa:validation:{index}",
            "publishedRow": index,
            "split": source["split"],
            "original": {key: row[key] for key in TEXT_COLUMNS},
            "figure": {"path": name, "upstreamPath": row["figure"]["path"],
                       "bytes": len(image), "sha256": digest(image)},
            "evidenceStatus": "published-text-unmapped-to-pdf" if row["evidence_reference"].strip()
                              else "missing-published-reference-evidence",
        })
    labels = json_bytes(tasks)
    manifest = {
        "schemaVersion": 1, "kind": "scientific-public-m3sciqa-validation-export",
        "sourceRevision": source["revision"], "sourceParquetHash": pin["sha256"],
        "license": source["license"], "annotationProvenance": source["annotationProvenance"],
        "tasks": len(tasks), "labelsPath": "labels.json", "labelsHash": digest(labels),
        "modalities": dict(sorted(Counter(task["original"]["modal"] for task in tasks).items())),
        "missingReferenceEvidence": sum(not task["original"]["evidence_reference"].strip() for task in tasks),
        "uniqueAnchorPapers": len({task["original"]["anchor_arxiv_id"] for task in tasks}),
        "uniqueReferencePapers": len({task["original"]["reference_arxiv_id"] for task in tasks}),
        "assets": [{"path": name, "bytes": len(data), "sha256": digest(data)}
                   for name, data in sorted(assets.items())],
        "exporterHash": digest(Path(__file__).read_bytes()),
        "scientificBaselineReady": False,
        "limitations": ["Published expert labels, no asserted local reviewer identities.",
                        "Original image crops are not complete paper PDFs or original-PDF locators.",
                        "Two missing reference-evidence rows are retained, never relabeled as unanswerable.",
                        "No hidden test labels are downloaded or replaced by generated answers."],
    }
    return {"labels.json": labels, **assets, "manifest.json": json_bytes(manifest)}, manifest


def prepare(source_root, output_root, verify=False):
    files, manifest = original_export(source_root)
    output_root = Path(output_root)
    for name, data in files.items():
        path = bounded_path(output_root, name)
        if verify or path.exists():
            if not path.is_file() or path.read_bytes() != data:
                raise ValueError(f"scientific_m3_export_changed:{name}")
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("xb") as output:
                output.write(data)
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=ROOT / "evaluation/local/sources/scientific-expert")
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    report = prepare(args.source_root, args.output_root, args.verify)
    print(json.dumps({key: report[key] for key in
                      ("tasks", "modalities", "missingReferenceEvidence", "uniqueAnchorPapers",
                       "uniqueReferencePapers", "labelsHash", "scientificBaselineReady")}, indent=2))
