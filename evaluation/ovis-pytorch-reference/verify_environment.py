"""Verify every private reference runtime entry against its pre-run local receipt."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import stat

from common import digest, write_json


def inventory(root: Path) -> dict:
    if root.is_symlink() or not root.is_dir():
        raise ValueError("Reference runtime root must be a directory, not a symlink")
    paths = [root]
    for folder, directories, files in os.walk(root, followlinks=False):
        paths.extend(Path(folder) / name for name in sorted(directories + files))
    entries = {}
    for path in paths:
        mode = stat.S_IMODE(path.lstat().st_mode)
        if path.is_symlink():
            row = {"type": "symlink", "target": os.readlink(path), "mode": mode}
        elif path.is_dir():
            row = {"type": "directory", "mode": mode}
        elif path.is_file():
            row = {"type": "file", "bytes": path.stat().st_size, "sha256": digest(path), "mode": mode}
        else:
            raise ValueError(f"Unexpected special runtime file: {path}")
        entries[path.relative_to(root).as_posix()] = row
    return entries


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    receipt = json.loads(args.receipt.read_text(encoding="utf-8"))
    if args.runtime.absolute() != Path(receipt["root"]):
        raise ValueError("Runtime path differs from the pre-run receipt")
    actual, expected = inventory(args.runtime), receipt["files"]
    changes = [p for p in sorted(set(actual) | set(expected)) if actual.get(p) != expected.get(p)]
    report = {"schemaVersion": 1, "status": "verified" if not changes else "changed",
              "receiptSha256": digest(args.receipt), "scriptSha256": digest(Path(__file__)),
              "expectedEntries": len(expected), "actualEntries": len(actual), "changes": changes}
    write_json(args.output, report)
    print(json.dumps(report))
    if changes:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
