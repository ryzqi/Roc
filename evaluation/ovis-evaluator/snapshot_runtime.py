#!/usr/bin/env python3
"""Record or verify every private runtime file, link and directory; omit only writable caches."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat

AREAS = ["python", "venv", "native", "texlive/2025", "OmniDocBench-0ff4f3cfbcd45636cc6d9933a551036893f0d83c"]


def inventory(root: Path) -> dict:
    result = {}
    for area in AREAS:
        base = root / area
        if base.is_symlink() or not base.is_dir():
            raise ValueError(f"invalid runtime area: {area}")
        paths = [base]
        for folder, directories, files in os.walk(base, followlinks=False):
            paths.extend(Path(folder) / name for name in sorted(directories + files))
        for path in paths:
            relative = path.relative_to(root).as_posix()
            mode = stat.S_IMODE(path.lstat().st_mode)
            if path.is_symlink():
                result[relative] = {"type": "symlink", "target": os.readlink(path), "mode": mode}
            elif path.is_dir():
                result[relative] = {"type": "directory", "mode": mode}
            elif path.is_file():
                with path.open("rb") as stream:
                    digest = hashlib.file_digest(stream, "sha256").hexdigest()
                result[relative] = {"type": "file", "bytes": path.stat().st_size, "sha256": digest, "mode": mode}
            else:
                raise ValueError(f"unexpected special runtime file: {path}")
    return dict(sorted(result.items()))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    files = inventory(args.runtime.absolute())
    if args.verify:
        recorded = json.loads(args.receipt.read_text(encoding="utf-8"))
        expected = recorded["files"]
        changes = [p for p in sorted(set(expected) | set(files)) if expected.get(p) != files.get(p)]
        if changes:
            raise ValueError(f"runtime file identity changed ({len(changes)}): {changes[:10]}")
        print(f"Verified {len(files)} runtime entries")
    else:
        receipt = {"schemaVersion": 1, "areas": AREAS, "excluded": ["task-private writable caches, downloads, installer staging"], "files": files}
        with args.receipt.open("x", encoding="utf-8") as stream:
            json.dump(receipt, stream, indent=2, ensure_ascii=False)
            stream.write("\n")
        print(f"Recorded {len(files)} runtime entries")


if __name__ == "__main__":
    main()
