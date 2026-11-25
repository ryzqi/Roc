#!/usr/bin/env python3
"""Acquire and exercise official evaluate/NLTK resources in the private cache."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from runtime import configure, sha256


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.output.exists():
        raise ValueError("resource receipt already exists")
    configure(args.runtime, offline=False)
    import nltk
    import evaluate

    runtime = args.runtime.absolute()
    for name in ["punkt", "punkt_tab", "wordnet", "omw-1.4"]:
        if not nltk.download(name, download_dir=str(runtime / "cache/nltk"), raise_on_error=True):
            raise RuntimeError(f"NLTK resource download failed: {name}")
    lock = json.loads((Path(__file__).parent / "environment.lock.json").read_text(encoding="utf-8"))
    modules = []
    for entry in lock["offlineResources"]["modules"]:
        name, revision = entry["name"], entry["revision"]
        metric = evaluate.load(name, revision=revision)
        result = metric.compute(predictions=["the cat sits on the mat"], references=[["the cat sits on the mat"]])
        if result != entry["identicalSentenceResult"]:
            raise ValueError(f"cached metric result changed: {name}")
        modules.append({"name": name, "repository": f"evaluate-metric/{name}", "revision": revision,
                        "classModule": type(metric).__module__, "identicalSentenceResult": result})
        print(name, revision, result, flush=True)
    files = [{"path": p.relative_to(runtime).as_posix(), "bytes": p.stat().st_size, "sha256": sha256(p)}
             for area in [runtime / "cache/nltk", runtime / "cache/huggingface/modules"]
             for p in sorted(area.rglob("*")) if p.is_file() and p.suffix != ".pyc" and p.name != ".lock"]
    configure(args.runtime, offline=True)
    receipt = {"schemaVersion": 1, "modules": modules, "files": files, "python": sys.version,
               "offlineRecheckRequired": True, "resourcesUsedByMainCDMTEDSGates": False}
    args.output.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
