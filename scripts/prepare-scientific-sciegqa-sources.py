"""Acquire and replay the exact public SciEGQA benchmark release.

Stream large published PDF/PNG archives to disk. Never execute dataset scripts,
extract archives, repair mismatched files, or import the generated training set.
"""
import argparse
import hashlib
import json
import os
import re
import sys
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCK = ROOT / "evaluation/corpora/scientific-rag/sciegqa-sources.lock.json"
MAX_BYTES = 2 * 1024**3
CHUNK_BYTES = 1024**2


def file_digest(path):
    value = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(CHUNK_BYTES), b""):
            value.update(chunk)
    return value.hexdigest()


def validate_lock(lock):
    files = lock.get("files")
    if (lock.get("schemaVersion") != 1 or lock.get("id") != "sciegqa-bench"
            or lock.get("split") != "test" or not isinstance(files, list)
            or not re.fullmatch(r"[a-f0-9]{40}", lock.get("revision", ""))
            or {p.get("path") for p in files} != {
                "README.md", "SciEGQA_Bench.jsonl", "PDF.tar", "Images.tar"}
            or len(files) != 4):
        raise ValueError("scientific_sciegqa_lock_invalid")
    total = 0
    for pin in files:
        url = urllib.parse.urlsplit(pin.get("url", ""))
        expected = f"/datasets/Yuwh07/SciEGQA-Bench/resolve/{lock['revision']}/{pin['path']}"
        if (url.scheme != "https" or url.netloc != "huggingface.co" or url.path != expected
                or url.query or url.fragment
                or type(pin.get("bytes")) is not int or not 0 < pin["bytes"] <= MAX_BYTES
                or not re.fullmatch(r"[a-f0-9]{64}", pin.get("sha256", ""))):
            raise ValueError("scientific_sciegqa_lock_invalid")
        total += pin["bytes"]
    if total > MAX_BYTES:
        raise ValueError("scientific_sciegqa_byte_budget_exceeded")
    return files


def checked_root(root, create=False):
    root = Path(os.path.abspath(root))
    for path in (*reversed(root.parents), root):
        if path.is_symlink() or (path.exists() and not path.is_dir()):
            raise ValueError("scientific_sciegqa_path_invalid")
    if create:
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not root.is_dir():
        raise ValueError("scientific_sciegqa_snapshot_missing")
    return root


def verify_file(path, pin):
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"scientific_sciegqa_source_missing:{pin['path']}")
    if path.stat().st_size != pin["bytes"] or file_digest(path) != pin["sha256"]:
        raise ValueError(f"scientific_sciegqa_source_changed:{pin['path']}")


def download(pin, root, opener=urllib.request.urlopen):
    target = root / pin["path"]
    temporary = root / f".{pin['path']}.acquiring-{uuid.uuid4().hex}"
    try:
        request = urllib.request.Request(pin["url"], headers={
            "User-Agent": "Roc-evaluation-source-acquisition/1"})
        with opener(request, timeout=45) as response, temporary.open("xb") as output:
            if response.status != 200:
                raise ValueError("scientific_sciegqa_download_failed")
            size = 0
            last_notice = 0
            digest = hashlib.sha256()
            while chunk := response.read(CHUNK_BYTES):
                size += len(chunk)
                if size > pin["bytes"]:
                    raise ValueError("scientific_sciegqa_download_too_large")
                digest.update(chunk)
                output.write(chunk)
                if size - last_notice >= 32 * CHUNK_BYTES:
                    print(f"{pin['path']}: {size}/{pin['bytes']} bytes", file=sys.stderr, flush=True)
                    last_notice = size
            if size != pin["bytes"] or digest.hexdigest() != pin["sha256"]:
                raise ValueError("scientific_sciegqa_download_changed")
        # Exclusive publication preserves a concurrent owner's result.
        os.link(temporary, target)
    finally:
        if temporary.exists():
            temporary.unlink()


def prepare(root, offline=False, lock=None, opener=urllib.request.urlopen):
    lock = lock if lock is not None else json.loads(LOCK.read_bytes())
    pins = validate_lock(lock)
    root = checked_root(root, create=not offline)
    for pin in pins:
        path = root / pin["path"]
        if path.exists() or path.is_symlink():
            verify_file(path, pin)
        elif offline:
            raise ValueError(f"scientific_sciegqa_source_missing:{pin['path']}")
        else:
            download(pin, root, opener)
            verify_file(path, pin)
    return {
        "schemaVersion": 1, "kind": "scientific-public-sciegqa-source-replay",
        "root": str(root), "revision": lock["revision"],
        "files": [{key: pin[key] for key in ("path", "bytes", "sha256")} for pin in pins],
        "totalBytes": sum(pin["bytes"] for pin in pins), "license": lock["license"],
        "scientificBaselineReady": False,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT / "evaluation/local/sources/sciegqa-bench")
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    report = prepare(args.root, offline=args.offline)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("x", encoding="utf-8") as output:
            json.dump(report, output, ensure_ascii=False, indent=2)
            output.write("\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))
