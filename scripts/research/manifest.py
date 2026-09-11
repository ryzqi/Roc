"""科研工具链完整性清单；拒绝外部链接和未记录的文件。"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import stat

from download_asset import file_sha256


def inventory(root: Path) -> list[dict]:
    root = root.resolve(strict=True)
    entries = []
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        if relative == "manifest.json":
            continue
        if path.is_symlink():
            target = os.readlink(path)
            if Path(target).is_absolute() or not path.resolve(strict=True).is_relative_to(root):
                raise ValueError(f"research_toolchain_external_symlink:{relative}")
            entries.append({"path": relative, "type": "symlink", "target": target})
        elif path.is_file():
            mode = path.stat().st_mode
            entries.append({"path": relative, "type": "file", "size": path.stat().st_size,
                            "sha256": file_sha256(path), "executable": bool(mode & stat.S_IXUSR)})
        elif not path.is_dir():
            raise ValueError(f"research_toolchain_file_type_invalid:{relative}")
    return entries


def write_manifest(root: Path, *, architecture: str, versions: dict[str, str], lock_hashes: dict[str, str]) -> dict:
    manifest = {"schemaVersion": 1, "platform": "darwin", "architecture": architecture,
                "versions": versions, "lockHashes": lock_hashes, "entries": inventory(root)}
    with (root / "manifest.json").open("x", encoding="utf-8") as stream:
        json.dump(manifest, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    return manifest


def verify_manifest(root: Path) -> dict:
    marker = root / "manifest.json"
    if marker.is_symlink():
        raise ValueError("research_toolchain_manifest_symlink")
    manifest = json.loads(marker.read_text(encoding="utf-8"))
    if manifest["schemaVersion"] != 1 or manifest["platform"] != "darwin" or manifest["architecture"] not in {"arm64", "x64"}:
        raise ValueError("research_toolchain_manifest_invalid")
    if inventory(root) != manifest["entries"]:
        raise ValueError("research_toolchain_integrity_mismatch")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    arguments = parser.parse_args()
    result = verify_manifest(arguments.root)
    print(f"科研工具链校验通过：{result['architecture']}，{len(result['entries'])} 个文件或链接")


if __name__ == "__main__":
    main()
