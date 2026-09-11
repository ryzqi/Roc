"""构建期下载：保留分块断点，校验资源身份与最终 SHA-256。"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
import hashlib
from http.client import IncompleteRead
import json
import os
from pathlib import Path
import re
import time
from urllib.error import URLError
from urllib.request import Request, urlopen


HEADERS = {"User-Agent": "Tectonic/0.17.0", "Accept-Encoding": "identity"}


@dataclass(frozen=True, slots=True)
class RemoteFile:
    url: str
    size: int
    etag: str | None


def file_sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def probe(url: str) -> RemoteFile:
    request = Request(url, headers={**HEADERS, "Range": "bytes=0-0"})
    with urlopen(request, timeout=45) as response:
        match = re.fullmatch(r"bytes 0-0/(\d+)", response.headers.get("Content-Range", ""))
        if response.status != 206 or match is None:
            raise ValueError("research_download_range_required")
        size = int(match[1])
        if size < 1 or len(response.read(2)) != 1:
            raise ValueError("research_download_size_invalid")
        return RemoteFile(url, size, response.headers.get("ETag"))


def download_ranges(remote: RemoteFile, target: Path, *, chunk_size: int = 4 * 1024 * 1024,
                    workers: int = 4, attempts: int = 12) -> None:
    """只在构建期使用；调用方必须在消费 target 之前验证完整哈希。"""
    if remote.size < 1 or chunk_size < 1 or workers < 1 or attempts < 1:
        raise ValueError("research_download_options_invalid")
    if target.is_symlink() or target.exists():
        raise ValueError("research_download_target_exists")
    parts = target.with_name(target.name + ".parts")
    if parts.is_symlink():
        raise ValueError("research_download_cache_symlink")
    parts.mkdir(parents=True, exist_ok=True)
    identity = {"url": remote.url, "size": remote.size, "etag": remote.etag, "chunkSize": chunk_size}
    marker = parts / "source.json"
    if marker.is_symlink():
        raise ValueError("research_download_cache_symlink")
    if marker.exists():
        if json.loads(marker.read_text(encoding="utf-8")) != identity:
            raise ValueError("research_download_source_changed")
    else:
        with marker.open("x", encoding="utf-8") as stream:
            json.dump(identity, stream)
    count = (remote.size + chunk_size - 1) // chunk_size

    def fetch(index: int) -> None:
        part = parts / f"{index:06d}.part"
        if part.is_symlink():
            raise ValueError("research_download_cache_symlink")
        length = min(chunk_size, remote.size - index * chunk_size)
        for attempt in range(attempts):
            offset = part.stat().st_size if part.exists() else 0
            if offset > length:
                raise ValueError("research_download_chunk_size_invalid")
            if offset == length:
                return
            start = index * chunk_size + offset
            end = index * chunk_size + length - 1
            headers = {**HEADERS, "Range": f"bytes={start}-{end}"}
            if remote.etag is not None:
                headers["If-Range"] = remote.etag
            try:
                with urlopen(Request(remote.url, headers=headers), timeout=45) as response:
                    expected_range = f"bytes {start}-{end}/{remote.size}"
                    if (response.status != 206 or response.headers.get("Content-Range") != expected_range
                            or response.headers.get("ETag") != remote.etag
                            or response.headers.get("Content-Encoding", "identity") != "identity"):
                        raise ValueError("research_download_source_changed")
                    remaining = length - offset
                    with part.open("ab") as stream:
                        while remaining:
                            try:
                                data = response.read(min(1024 * 1024, remaining))
                            except IncompleteRead as error:
                                data = error.partial
                            if not data:
                                raise OSError("research_download_incomplete")
                            stream.write(data)
                            remaining -= len(data)
                        stream.flush()
                        os.fsync(stream.fileno())
                return
            except (OSError, URLError) as error:
                if attempt + 1 == attempts:
                    raise OSError(f"research_download_chunk_incomplete:{index}") from error
                time.sleep(min(2 ** attempt, 10))

    with ThreadPoolExecutor(max_workers=workers) as executor:
        for index, _ in enumerate(executor.map(fetch, range(count)), start=1):
            if index % 32 == 0 or index == count:
                print(f"资源分块 {index}/{count}", flush=True)
    assembling = parts / "assembled"
    if assembling.is_symlink():
        raise ValueError("research_download_cache_symlink")
    with assembling.open("wb") as output:
        for index in range(count):
            with (parts / f"{index:06d}.part").open("rb") as source:
                while data := source.read(1024 * 1024):
                    output.write(data)
        output.flush()
        os.fsync(output.fileno())
    assembling.rename(target)


def download_verified(url: str, expected_sha256: str, target: Path, *, expected_size: int | None = None) -> Path:
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha256):
        raise ValueError("research_download_digest_invalid")
    if target.is_symlink():
        raise ValueError("research_download_target_symlink")
    if not target.exists():
        remote = probe(url)
        if expected_size is not None and remote.size != expected_size:
            raise ValueError("research_download_size_mismatch")
        download_ranges(remote, target)
    if (expected_size is not None and target.stat().st_size != expected_size) or file_sha256(target) != expected_sha256:
        raise ValueError(f"research_download_hash_mismatch:{target.name}")
    return target
