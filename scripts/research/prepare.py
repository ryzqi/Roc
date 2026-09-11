"""组装可搬迁的 macOS 科研工具链；所有生成资源留在指定目录。"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile
import tomllib

from archive_utils import convert_tex_bundle, extract_tool_archive
from download_asset import download_verified, file_sha256
from manifest import verify_manifest, write_manifest


PROJECT_ROOT = Path(__file__).resolve().parents[2]
SOURCES = PROJECT_ROOT / "resources/research-runtime"
LOCK_FILES = ("pyproject.toml", "uv.lock", "tools.lock.json", "models.lock.json")


def build_environment(cache: Path) -> dict[str, str]:
    environment = {key: os.environ[key] for key in ("PATH", "HOME", "TMPDIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
                                                   "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE") if key in os.environ}
    environment.update({"UV_CACHE_DIR": str(cache / "uv"), "UV_NO_PROGRESS": "1", "UV_PYTHON_DOWNLOADS": "never",
                        "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1",
                        "HF_HUB_DISABLE_IMPLICIT_TOKEN": "1", "HF_HUB_DISABLE_TELEMETRY": "1", "HF_HUB_DISABLE_XET": "1"})
    return environment


def portable_python(prefix: Path) -> None:
    for script in (prefix / "bin").iterdir():
        if script.is_symlink() or not script.is_file():
            continue
        with script.open("rb") as stream:
            first = stream.readline(4096)
            second = stream.readline(4096) if first == b"#!/bin/sh\n" else b""
        if first.startswith(b"#!") and (str(prefix).encode() in first or
                                         (second.startswith(b"'''exec' ") and str(prefix).encode() in second)):
            content = script.read_text(encoding="utf-8")
            body = content.split("\n", 3)[3] if second else content.split("\n", 1)[1]
            wrapper = '#!/bin/sh\n\'\'\'exec\' "$(dirname "$0")/python3" "$0" "$@"\n\' \'\'\'\n'
            script.write_text(wrapper + body, encoding="utf-8")
    kernel = prefix / "share/jupyter/kernels/python3/kernel.json"
    if kernel.is_file():
        value = json.loads(kernel.read_text(encoding="utf-8"))
        value["argv"][0] = "python3"
        kernel.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for bytecode in prefix.rglob("*.pyc"):
        if bytecode.is_symlink() or not bytecode.resolve().is_relative_to(prefix.resolve()):
            raise ValueError("research_python_bytecode_path_invalid")
        bytecode.unlink()


def prepare(architecture: str, output: Path, cache: Path, model_cache: Path) -> None:
    host = {"arm64": "arm64", "x86_64": "x64"}.get(platform.machine())
    if sys.platform != "darwin" or architecture != host:
        raise ValueError("research_toolchain_build_requires_matching_macos_host")
    if output.is_symlink() or cache.is_symlink() or model_cache.is_symlink():
        raise ValueError("research_toolchain_directory_symlink")
    output, cache, model_cache = output.resolve(), cache.resolve(), model_cache.resolve()
    if any(output.is_relative_to(source) or source.is_relative_to(output) for source in (cache, model_cache)):
        raise ValueError("research_toolchain_output_overlaps_cache")
    lock_hashes = {name: file_sha256(SOURCES / name) for name in LOCK_FILES}
    lock_hashes["worker.py"] = file_sha256(SOURCES / "worker.py")
    for license_file in sorted((SOURCES / "licenses").rglob("*")):
        if license_file.is_file():
            lock_hashes[license_file.relative_to(SOURCES).as_posix()] = file_sha256(license_file)
    for name in ("prepare.py", "archive_utils.py", "download_asset.py", "fetch-models.py", "manifest.py", "collect_licenses.py"):
        lock_hashes[f"scripts/{name}"] = file_sha256(Path(__file__).with_name(name))
    tools = json.loads((SOURCES / "tools.lock.json").read_text(encoding="utf-8"))
    if tools["schemaVersion"] != 1:
        raise ValueError("research_tools_lock_invalid")
    if output.exists():
        existing = verify_manifest(output)
        if existing["lockHashes"] != lock_hashes or existing["architecture"] != architecture:
            raise ValueError("research_toolchain_existing_sources_differ_use_new_output")
        print(f"已有工具链校验通过：{output}", flush=True)
        return
    cache.mkdir(parents=True, exist_ok=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    environment = build_environment(cache)
    lock_path = cache / "prepare.lock"
    if lock_path.is_symlink():
        raise ValueError("research_toolchain_lock_symlink")
    with lock_path.open("a") as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with tempfile.TemporaryDirectory(prefix=".research-toolchain-", dir=output.parent) as temporary:
            staging = Path(temporary)
            root = staging / "toolchain"
            root.mkdir()
            (root / "bin").mkdir()
            for name, item in tools["architectures"][architecture].items():
                archive = download_verified(item["url"], item["sha256"], cache / f"{name}-{architecture}.tar.gz")
                extracted = staging / name
                extract_tool_archive(archive, extracted)
                if name == "python":
                    shutil.move(extracted / "python", root / "python")
                else:
                    candidates = [path for path in extracted.rglob(name) if path.is_file() and not path.is_symlink()]
                    if len(candidates) != 1:
                        raise ValueError(f"research_tool_binary_ambiguous:{name}")
                    shutil.copy2(candidates[0], root / "bin" / name)
            python = root / "python/bin/python3"
            uv = root / "bin/uv"
            requirements = root / "requirements.txt"
            project = tomllib.loads((SOURCES / "pyproject.toml").read_text(encoding="utf-8"))
            constraints = root / "build-constraints.txt"
            constraints.write_text("\n".join(project["tool"]["uv"]["build-constraint-dependencies"]) + "\n", encoding="utf-8")
            subprocess.run([uv, "export", "--locked", "--no-dev", "--no-emit-project", "--no-header",
                            "--no-annotate", "--project", SOURCES, "--python", python, "--output-file", requirements],
                           env=environment, stdout=subprocess.DEVNULL, check=True)
            subprocess.run([uv, "pip", "sync", "--python", python, "--require-hashes", "--strict",
                            "--link-mode", "copy", "--default-index", "https://pypi.org/simple",
                            "--build-constraints", constraints, requirements],
                           env=environment, check=True)
            subprocess.run([python, Path(__file__).with_name("fetch-models.py"), "--lock", SOURCES / "models.lock.json",
                            "--output", model_cache], env=environment, check=True)
            (root / "models").mkdir()
            models = json.loads((SOURCES / "models.lock.json").read_text(encoding="utf-8"))
            for model in models["models"]:
                shutil.copytree(model_cache / model["directory"], root / "models" / model["directory"], symlinks=True)
            bundle = tools["texBundle"]
            archive = download_verified(bundle["url"], bundle["sha256"], cache / "tlextras-2022.0r0.tar", expected_size=bundle["size"])
            cached_zip = cache / "tex-bundle.zip"
            if not cached_zip.exists():
                convert_tex_bundle(archive, cached_zip)
            if file_sha256(cached_zip) != bundle["zipSha256"]:
                raise ValueError("research_tex_zip_hash_mismatch")
            (root / "tex").mkdir()
            shutil.copy2(cached_zip, root / "tex/bundle.zip")
            shutil.copy2(SOURCES / "worker.py", root / "worker.py")
            (root / "locks").mkdir()
            for name in LOCK_FILES:
                shutil.copy2(SOURCES / name, root / "locks" / name)
            shutil.copytree(SOURCES / "licenses", root / "licenses")
            collected = subprocess.run([python, Path(__file__).with_name("collect_licenses.py"), root],
                                       env=environment, text=True, capture_output=True, check=True)
            (root / "licenses/python-packages.json").write_text(collected.stdout, encoding="utf-8")
            portable_python(root / "python")
            versions = {name: tools[f"{name}Version"] for name in ("python", "uv", "tectonic")}
            manifest = write_manifest(root, architecture=architecture, versions=versions, lock_hashes=lock_hashes)
            root.rename(output)
            print(f"科研工具链已准备：{output}（{len(manifest['entries'])} 个文件或链接）", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--arch", choices=("arm64", "x64"), required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cache", type=Path, default=PROJECT_ROOT / ".runtime/research-downloads")
    parser.add_argument("--models", type=Path, default=PROJECT_ROOT / ".runtime/research-models")
    arguments = parser.parse_args()
    prepare(arguments.arch, arguments.output, arguments.cache, arguments.models)


if __name__ == "__main__":
    main()
