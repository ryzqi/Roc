"""按提交与完整文件哈希下载可离线使用的科研模型。"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import fcntl
import hashlib
import json
from pathlib import Path
import re
import shutil

from huggingface_hub import snapshot_download
from huggingface_hub.utils import disable_progress_bars


@dataclass(frozen=True, slots=True)
class ModelSource:
    repo_id: str
    revision: str
    directory: str
    license: str
    files: dict[str, str]


def read_sources(path: Path) -> list[ModelSource]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if value["schemaVersion"] != 1 or not value["models"]:
        raise ValueError("research_models_lock_invalid")
    sources = []
    for item in value["models"]:
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", item["repoId"]):
            raise ValueError("research_model_repo_invalid")
        if not re.fullmatch(r"[0-9a-f]{40}", item["revision"]):
            raise ValueError("research_model_revision_invalid")
        if not re.fullmatch(r"[A-Za-z0-9_-]+", item["directory"]):
            raise ValueError("research_model_directory_invalid")
        if not item["files"]:
            raise ValueError("research_model_files_required")
        for filename, digest in item["files"].items():
            if (Path(filename).is_absolute() or ".." in Path(filename).parts or ".cache" in Path(filename).parts
                    or filename == "roc-source.json" or "\\" in filename):
                raise ValueError("research_model_file_path_invalid")
            if not re.fullmatch(r"[0-9a-f]{64}", digest):
                raise ValueError("research_model_digest_invalid")
        sources.append(ModelSource(item["repoId"], item["revision"], item["directory"], item["license"], item["files"]))
    if len({source.directory for source in sources}) != len(sources):
        raise ValueError("research_model_directory_duplicate")
    return sources


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verify_files(root: Path, source: ModelSource) -> None:
    for path in root.rglob("*"):
        if path.is_symlink():
            raise ValueError("research_model_symlink")
        if path.is_file() and path.relative_to(root).as_posix() not in {*source.files, "roc-source.json"}:
            raise ValueError("research_model_unexpected_file")
    for filename, expected in source.files.items():
        path = root / filename
        if path.is_symlink() or not path.is_file() or sha256(path) != expected:
            raise ValueError(f"research_model_hash_mismatch:{source.directory}/{filename}")


def fetch(source: ModelSource, output: Path) -> None:
    downloads = output / ".downloads"
    if downloads.is_symlink():
        raise ValueError("research_model_download_cache_symlink")
    downloads.mkdir(exist_ok=True)
    lock_path = downloads / f"{source.directory}.lock"
    if lock_path.is_symlink():
        raise ValueError("research_model_download_lock_symlink")
    with lock_path.open("a") as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fetch_locked(source, output, downloads)


def fetch_locked(source: ModelSource, output: Path, downloads: Path) -> None:
    destination = output / source.directory
    marker = destination / "roc-source.json"
    expected_marker = {"repoId": source.repo_id, "revision": source.revision, "license": source.license}
    if destination.exists():
        if destination.is_symlink() or marker.is_symlink() or not marker.is_file() or json.loads(marker.read_text(encoding="utf-8")) != expected_marker:
            raise ValueError(f"research_model_existing_directory_conflict:{destination}")
        verify_files(destination, source)
        print(f"已校验 {source.repo_id}", flush=True)
        return
    staging = downloads / f"{source.directory}-{source.revision}"
    if staging.is_symlink():
        raise ValueError("research_model_download_staging_symlink")
    staging.mkdir(exist_ok=True)
    if any(path.is_symlink() for path in staging.rglob("*")):
        raise ValueError("research_model_download_cache_symlink")
    print(f"下载 {source.repo_id}@{source.revision}", flush=True)
    snapshot_download(
        repo_id=source.repo_id,
        revision=source.revision,
        local_dir=staging,
        allow_patterns=list(source.files),
        token=False,
        max_workers=4,
    )
    cache = staging / ".cache"
    if cache.exists():
        if cache.is_symlink() or not cache.resolve().is_relative_to(staging.resolve()):
            raise ValueError("research_model_cache_path_invalid")
        shutil.rmtree(cache)
    verify_files(staging, source)
    (staging / "roc-source.json").write_text(json.dumps(expected_marker, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    staging.rename(destination)
    print(f"已固定 {source.repo_id}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lock", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    arguments = parser.parse_args()
    if arguments.output.is_symlink():
        raise ValueError("research_model_output_symlink")
    output = arguments.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    disable_progress_bars()
    for source in read_sources(arguments.lock):
        fetch(source, output)


if __name__ == "__main__":
    main()
