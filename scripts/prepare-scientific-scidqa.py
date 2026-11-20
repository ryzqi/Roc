"""Acquire pinned SciDQA sources and faithfully export published expert-revised QA.

Offline replay and --verify never download or overwrite. No evidence locations,
task categories, answers or reviewer identities are generated.
"""
import argparse
import hashlib
import json
import os
import re
import urllib.parse
import urllib.request
import uuid
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCK = ROOT / "evaluation/corpora/scientific-rag/scidqa-sources.lock.json"
FIELDS = {"id", "year", "venue", "rid", "pid", "decision", "que", "ans", "version"}
MAX_BYTES = 16 * 1024**2


def digest(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode()


def checked_root(root, create=False):
    root = Path(os.path.abspath(root))
    for path in (*reversed(root.parents), root):
        if path.is_symlink() or (path.exists() and not path.is_dir()):
            raise ValueError("scientific_scidqa_path_invalid")
    if create:
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not root.is_dir():
        raise ValueError("scientific_scidqa_snapshot_missing")
    return root


def validate_lock(lock):
    files = lock.get("files")
    if (lock.get("schemaVersion") != 1 or lock.get("id") != "scidqa"
            or lock.get("dataset") != "yale-nlp/SciDQA" or lock.get("split") != "test"
            or lock.get("license") != "ODC-By-1.0"
            or not re.fullmatch(r"[a-f0-9]{40}", lock.get("revision", ""))
            or not isinstance(files, list) or len(files) != 3
            or {p.get("path") for p in files} != {"README.md", "test.jsonl", "publication.pdf"}):
        raise ValueError("scientific_scidqa_lock_invalid")
    for pin in files:
        expected = ("https://aclanthology.org/2024.emnlp-main.1163.pdf"
                    if pin["path"] == "publication.pdf" else
                    f"https://huggingface.co/datasets/yale-nlp/SciDQA/resolve/{lock['revision']}/{pin['path']}")
        if (pin.get("url") != expected or type(pin.get("bytes")) is not int
                or not 0 < pin["bytes"] <= MAX_BYTES
                or not re.fullmatch(r"[a-f0-9]{64}", pin.get("sha256", ""))):
            raise ValueError("scientific_scidqa_lock_invalid")
    if sum(p["bytes"] for p in files) > MAX_BYTES:
        raise ValueError("scientific_scidqa_byte_budget_exceeded")
    return files


def verify_file(root, pin):
    path = root / pin["path"]
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"scientific_scidqa_source_missing:{pin['path']}")
    if path.stat().st_size != pin["bytes"]:
        raise ValueError(f"scientific_scidqa_source_changed:{pin['path']}")
    data = path.read_bytes()
    if digest(data) != pin["sha256"]:
        raise ValueError(f"scientific_scidqa_source_changed:{pin['path']}")
    return data


def download(root, pin, opener=urllib.request.urlopen):
    temporary = root / f".{pin['path']}.acquiring-{uuid.uuid4().hex}"
    try:
        request = urllib.request.Request(pin["url"], headers={
            "User-Agent": "Roc-evaluation-source-acquisition/1"})
        with opener(request, timeout=45) as response:
            if response.status != 200 or urllib.parse.urlsplit(response.url).scheme != "https":
                raise ValueError("scientific_scidqa_download_failed")
            data = response.read(pin["bytes"] + 1)
        if len(data) != pin["bytes"] or digest(data) != pin["sha256"]:
            raise ValueError("scientific_scidqa_download_changed")
        with temporary.open("xb") as output:
            output.write(data)
        os.link(temporary, root / pin["path"])
    finally:
        if temporary.exists():
            temporary.unlink()


def original_export(source_root, lock, exporter_hash):
    pins = validate_lock(lock)
    originals = {p["path"]: verify_file(source_root, p) for p in pins}
    if not originals["publication.pdf"].startswith(b"%PDF-"):
        raise ValueError("scientific_scidqa_publication_invalid")
    rows = [json.loads(line) for line in originals["test.jsonl"].decode("utf-8").splitlines() if line.strip()]
    if len(rows) != lock["expectedRows"]:
        raise ValueError("scientific_scidqa_rows_changed")
    seen, labels = set(), []
    for index, row in enumerate(rows):
        if (not isinstance(row, dict) or set(row) != FIELDS
                or type(row["id"]) is not int or row["id"] <= 0 or row["id"] in seen
                or type(row["year"]) is not int
                or any(not isinstance(row[k], str) or not row[k].strip()
                       for k in FIELDS - {"id", "year"})
                or row["version"] not in ("Initial", "Revised")):
            raise ValueError("scientific_scidqa_label_invalid")
        seen.add(row["id"])
        labels.append({
            "id": f"scidqa:test:{row['id']}", "publishedRow": index,
            "original": row, "sourceDocumentVersion": row["version"],
            "planCategory": None, "answerable": None, "expectedEvidenceSpans": None,
            "evidenceStatus": "no-complete-published-document-evidence",
        })
    versions = dict(sorted(Counter(r["version"] for r in rows).items()))
    papers = len({r["pid"] for r in rows})
    if papers != lock["expectedPapers"] or versions != lock["expectedVersions"]:
        raise ValueError("scientific_scidqa_inventory_changed")
    data = json_bytes(labels)
    manifest = {
        "schemaVersion": 1, "kind": "scientific-public-scidqa-expert-qa-export",
        "sourceRevision": lock["revision"], "sourceLockHash": digest(json_bytes(lock)),
        "license": lock["license"], "annotationProvenance": lock["annotationProvenance"],
        "sourceFiles": [{k: p[k] for k in ("path", "bytes", "sha256")} for p in pins],
        "tasks": len(labels), "papers": papers, "versions": versions,
        "labelsPath": "labels.json", "labelsHash": digest(data), "exporterHash": exporter_hash,
        "completeEvidenceQueries": 0, "qualityMetrics": None,
        "scientificBaselineReady": False, "limitations": lock["limitations"],
    }
    return {"labels.json": data, "manifest.json": json_bytes(manifest)}, manifest


def prepare(source_root, output_root, offline=False, verify=False, lock=None,
            opener=urllib.request.urlopen):
    lock = lock if lock is not None else json.loads(LOCK.read_bytes())
    pins = validate_lock(lock)
    source_root = Path(os.path.abspath(source_root))
    output_root = Path(os.path.abspath(output_root))
    if (source_root.is_relative_to(output_root) or output_root.is_relative_to(source_root)):
        raise ValueError("scientific_scidqa_output_overlaps_source")
    # Check both paths before creating directories or acquiring files.
    for root in (source_root, output_root):
        for path in (*reversed(root.parents), root):
            if path.is_symlink() or (path.exists() and not path.is_dir()):
                raise ValueError("scientific_scidqa_path_invalid")
    source_root = checked_root(source_root, create=not (offline or verify))
    for pin in pins:
        path = source_root / pin["path"]
        if path.exists() or path.is_symlink() or offline or verify:
            verify_file(source_root, pin)
        else:
            download(source_root, pin, opener)
    files, manifest = original_export(source_root, lock, digest(Path(__file__).read_bytes()))
    output_root = checked_root(output_root, create=not verify)
    for name, data in files.items():
        path = output_root / name
        if path.is_symlink():
            raise ValueError("scientific_scidqa_path_invalid")
        if verify or path.exists():
            if not path.is_file() or path.read_bytes() != data:
                raise ValueError(f"scientific_scidqa_export_changed:{name}")
        else:
            with path.open("xb") as output:
                output.write(data)
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=ROOT / "evaluation/local/sources/scidqa")
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    report = prepare(args.source_root, args.output_root, args.offline, args.verify)
    print(json.dumps({k: report[k] for k in ("tasks", "papers", "versions", "labelsHash",
                                          "completeEvidenceQueries", "scientificBaselineReady")}, indent=2))
