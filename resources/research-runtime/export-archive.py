"""按已校验的文件清单生成可搬迁 ZIP，不覆盖已有归档。"""

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import sys
import zipfile


def create_archive(root: Path, destination: Path, entries: list[dict[str, object]]) -> dict[str, object]:
    root = root.resolve(strict=True)
    if not entries or len(entries) > 10000:
        raise ValueError("research_export_file_limit")
    seen: set[str] = set()
    total = 0
    with zipfile.ZipFile(destination, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for entry in entries:
            name = entry["path"]
            if not isinstance(name, str) or "\\" in name or any(ord(character) < 32 for character in name):
                raise ValueError("research_export_path_invalid")
            parts = name.split("/")
            if name.startswith("/") or any(part in ("", ".", "..") for part in parts) or name in seen:
                raise ValueError("research_export_path_invalid")
            seen.add(name)
            path = root
            for part in parts:
                path = path / part
                if path.is_symlink():
                    raise ValueError("research_export_path_symlink")
            path.resolve(strict=True).relative_to(root)
            with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as source:
                before = os.fstat(source.fileno())
                if not stat.S_ISREG(before.st_mode) or before.st_size > 64 * 1024 * 1024:
                    raise ValueError("research_export_file_limit")
                data = source.read(64 * 1024 * 1024 + 1)
                after = os.fstat(source.fileno())
            total += len(data)
            if total > 512 * 1024 * 1024 or len(data) != entry["size"] or hashlib.sha256(data).hexdigest() != entry["sha256"]:
                raise ValueError("research_export_snapshot_changed")
            if before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns:
                raise ValueError("research_export_snapshot_changed")
            info = zipfile.ZipInfo(PurePosixPath(name).as_posix(), date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100444 << 16
            archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=6)
    digest = hashlib.sha256()
    with destination.open("rb") as archive:
        for block in iter(lambda: archive.read(1024 * 1024), b""):
            digest.update(block)
    return {"sha256": digest.hexdigest(), "size": destination.stat().st_size}


if __name__ == "__main__":
    root, destination, manifest = map(Path, sys.argv[1:])
    entries = json.loads(manifest.read_text(encoding="utf-8"))
    print(json.dumps(create_archive(root, destination, entries), allow_nan=False))
