"""工具链归档的受控解包与离线 TeX 格式转换。"""

from __future__ import annotations

import os
from pathlib import Path, PurePosixPath
import shutil
import tarfile
import tempfile
import zipfile


def extract_tool_archive(archive: Path, destination: Path) -> None:
    if destination.exists() or destination.is_symlink():
        raise ValueError("research_archive_destination_exists")
    destination.mkdir(parents=True)
    with tarfile.open(archive) as source:
        members = source.getmembers()
        if len(members) > 100_000 or sum(member.size for member in members) > 4 * 1024 ** 3:
            raise ValueError("research_archive_too_large")
        for member in members:
            name = PurePosixPath(member.name)
            if name.is_absolute() or ".." in name.parts or not (member.isfile() or member.isdir() or member.issym()):
                raise ValueError("research_archive_entry_invalid")
        source.extractall(destination, members=members, filter="data")


def convert_tex_bundle(source: Path, destination: Path) -> None:
    """原始 bundle 为扁平 TAR；ZIP 保留同名文件及原 SHA256SUM。"""
    if destination.exists() or destination.is_symlink():
        raise ValueError("research_tex_bundle_destination_exists")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".tex-bundle-", dir=destination.parent) as temporary:
        target = Path(temporary) / "bundle.zip"
        names: set[str] = set()
        total = 0
        with tarfile.open(source) as archive, zipfile.ZipFile(target, "x", compression=zipfile.ZIP_DEFLATED,
                                                            compresslevel=6, allowZip64=True) as output:
            for member in archive:
                name = PurePosixPath(member.name)
                if (not member.isfile() or len(name.parts) != 1 or name.name in {"", ".", ".."}
                        or "\\" in member.name or member.name in names):
                    raise ValueError("research_tex_bundle_entry_invalid")
                total += member.size
                if total > 4 * 1024 ** 3 or member.size > 512 * 1024 ** 2 or len(names) >= 200_000:
                    raise ValueError("research_tex_bundle_too_large")
                names.add(member.name)
                info = zipfile.ZipInfo(member.name, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                with archive.extractfile(member) as content, output.open(info, "w") as entry:
                    shutil.copyfileobj(content, entry)
            if "SHA256SUM" not in names or "tectonic-format-latex.tex" not in names:
                raise ValueError("research_tex_bundle_metadata_missing")
        os.link(target, destination)
