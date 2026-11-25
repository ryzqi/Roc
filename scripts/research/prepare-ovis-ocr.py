"""Prepare the pinned OvisOCR3 MLX 8-bit runtime in a new explicit directory.

This is an installation/conversion tool, not a successful-inference certificate.
It never updates an existing installation or downloads an interpreter.
"""

from __future__ import annotations

import argparse
import contextlib
import ctypes
import hashlib
import json
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

RESOURCES = Path(__file__).resolve().parents[2] / "resources/ovis-ocr"
RECEIPT = "receipt.json"
SPEC_FILES = ("manifest.json", "requirements.in", "requirements.lock", "convert.py")
HASH = re.compile(r"[0-9a-f]{64}")
PROBE = """
import json, platform, sys, sysconfig
from pathlib import Path
print(json.dumps({
    'implementation': sys.implementation.name,
    'pythonVersion': platform.python_version(),
    'system': platform.system(), 'machine': platform.machine(),
    'macOS': platform.mac_ver()[0], 'version': sys.version,
    'basePrefix': sys.base_prefix, 'prefix': sys.prefix,
    'executable': sys.executable, 'freeThreaded': bool(sysconfig.get_config_var('Py_GIL_DISABLED')),
    'sharedLibrary': str(Path(sysconfig.get_config_var('LIBDIR')) / sysconfig.get_config_var('LDLIBRARY'))
        if sysconfig.get_config_var('Py_ENABLE_SHARED') else None,
}))
"""
PACKAGES = """
import importlib.metadata, json, re
print(json.dumps(dict(sorted(
    (re.sub(r'[-_.]+', '-', d.metadata['Name']).lower(), d.version)
    for d in importlib.metadata.distributions()
))))
"""


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read_json(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected JSON object: {path.name}")
    return value


def write_json(path: Path, value: dict) -> None:
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, ensure_ascii=False, sort_keys=True)
        stream.write("\n")


def relative_path(name: str) -> Path:
    if not name or "\\" in name or any(p in ("", ".", "..") for p in name.split("/")):
        raise ValueError(f"Invalid relative path: {name!r}")
    path = Path(name)
    if path.is_absolute():
        raise ValueError(f"Absolute member path: {name!r}")
    return path


def locked_packages(path: Path) -> dict[str, str]:
    packages = {}
    logical = path.read_text(encoding="utf-8").replace("\\\n", " ")
    for line in logical.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        match = re.fullmatch(r"([a-z0-9][a-z0-9-]*)==([^\s;]+)((?:\s+--hash=sha256:[0-9a-f]{64})+)", line)
        if not match or match[1] in packages:
            raise ValueError("Lock must contain unique exact pins with SHA256 hashes only")
        packages[match[1]] = match[2]
    if not packages:
        raise ValueError("Empty dependency lock")
    return dict(sorted(packages.items()))


def load_spec() -> tuple[dict, dict[str, str], dict[str, str]]:
    manifest = read_json(RESOURCES / "manifest.json")
    if manifest["schemaVersion"] != 1:
        raise ValueError("Unsupported manifest schema")
    names = set()
    for entry in manifest["model"]["files"]:
        relative_path(entry["path"])
        if (entry["path"] in names or not HASH.fullmatch(entry["sha256"])
                or type(entry["size"]) is not int or entry["size"] <= 0):
            raise ValueError("Invalid model file manifest")
        names.add(entry["path"])
    identities = {name: sha256(RESOURCES / name) for name in SPEC_FILES}
    identities["prepare-ovis-ocr.py"] = sha256(Path(__file__).resolve())
    return manifest, locked_packages(RESOURCES / "requirements.lock"), identities


def process_env(scratch: Path, *, offline: bool = False) -> dict[str, str]:
    env = {
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8",
        "TMPDIR": str(scratch), "XDG_CACHE_HOME": str(scratch / "xdg"),
        "UV_CACHE_DIR": str(scratch / "uv"), "UV_PYTHON_DOWNLOADS": "never",
        "UV_PYTHON_INSTALL_DIR": str(scratch / "python"),
        "HF_HOME": str(scratch / "huggingface"), "HF_HUB_DISABLE_TELEMETRY": "1",
        "DO_NOT_TRACK": "1", "TOKENIZERS_PARALLELISM": "false",
    }
    if offline:
        env.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1")
    return env


def run(command: list[str], env: dict[str, str], *, capture: bool = False) -> str:
    process = subprocess.Popen(command, env=env, start_new_session=True,
                               stdout=subprocess.PIPE if capture else None, text=True)
    try:
        output, _ = process.communicate(timeout=3600)
        if process.returncode:
            raise subprocess.CalledProcessError(process.returncode, command)
        return output or ""
    except BaseException:
        # The group can outlive its leader after a failed/cancelled subprocess.
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        if process.poll() is None:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
        raise


def probe_python(python: Path, manifest: dict, env: dict[str, str]) -> dict:
    identity = json.loads(run([str(python), "-I", "-S", "-B", "-c", PROBE], env, capture=True))
    expected = manifest["runtime"]
    for key in ("implementation", "pythonVersion", "system", "machine"):
        if identity[key] != expected[key]:
            raise ValueError(f"Interpreter {key} must be {expected[key]}")
    if identity["freeThreaded"]:
        raise ValueError("Free-threaded Python is not supported by this lock")
    if tuple(map(int, identity["macOS"].split("."))) < tuple(map(int, expected["minimumMacOS"].split("."))):
        raise ValueError(f"macOS {expected['minimumMacOS']} or newer is required")
    identity["executableSha256"] = sha256(python)
    if identity["sharedLibrary"]:
        library = Path(identity["sharedLibrary"]).resolve(strict=True)
        identity["sharedLibrary"] = str(library)
        identity["sharedLibrarySha256"] = sha256(library)
    return identity


def verify_file(path: Path, expected: dict) -> None:
    if (path.is_symlink() or not path.is_file() or path.stat().st_size != expected["size"]
            or sha256(path) != expected["sha256"]):
        raise ValueError(f"File verification failed: {path.name}")


def download(url: str, target: Path, expected: dict) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    size = 0
    with urllib.request.urlopen(url, timeout=60) as response, target.open("xb") as output:
        while chunk := response.read(1024 * 1024):
            size += len(chunk)
            if size > expected["size"]:
                raise ValueError(f"Download exceeds expected size: {target.name}")
            digest.update(chunk)
            output.write(chunk)
    if size != expected["size"] or digest.hexdigest() != expected["sha256"]:
        raise ValueError(f"Download checksum mismatch: {target.name}")


def extract_uv(archive: Path, target: Path, spec: dict) -> None:
    # Extract a single pinned regular member, never archive paths or links.
    with tarfile.open(archive, "r:gz") as stream:
        candidates = [member for member in stream if member.name == spec["member"]]
        if len(candidates) != 1 or not candidates[0].isfile() or candidates[0].size != spec["binarySize"]:
            raise ValueError("Unexpected uv archive member")
        with stream.extractfile(candidates[0]) as source, target.open("xb") as output:
            shutil.copyfileobj(source, output)
    verify_file(target, {"size": spec["binarySize"], "sha256": spec["binarySha256"]})
    target.chmod(0o700)


def inventory(root: Path, python: Path) -> dict:
    result = {}
    for folder, directories, files in os.walk(root, followlinks=False):
        for name in sorted(directories + files):
            path = Path(folder) / name
            relative = path.relative_to(root).as_posix()
            if relative == RECEIPT:
                continue
            mode = path.lstat().st_mode
            entry = {"mode": stat.S_IMODE(mode)}
            if stat.S_ISLNK(mode):
                resolved = path.resolve(strict=True)
                if not resolved.is_relative_to(root) and resolved != python:
                    raise ValueError(f"Unexpected external symlink: {relative}")
                entry.update(type="symlink", target=os.readlink(path))
            elif stat.S_ISDIR(mode):
                entry.update(type="directory")
            elif stat.S_ISREG(mode):
                entry.update(type="file", size=path.stat().st_size, sha256=sha256(path))
            else:
                raise ValueError(f"Unexpected file type: {relative}")
            result[relative] = entry
    return dict(sorted(result.items()))


@contextlib.contextmanager
def owned_stage(root: Path) -> Iterator[Path]:
    lock = root.with_name(f".{root.name}.preparing")
    # A concurrent/crashed preparation is explicit; never remove someone else's lock.
    lock.mkdir(mode=0o700)
    try:
        yield Path(tempfile.mkdtemp(prefix="stage-", dir=lock))
    finally:
        shutil.rmtree(lock)


def publish(stage: Path, root: Path) -> None:
    # Darwin RENAME_EXCL closes the exists-check/rename race without overwriting.
    libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    rename = libc.renamex_np
    rename.argtypes = (ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint)
    rename.restype = ctypes.c_int
    if rename(os.fsencode(stage), os.fsencode(root), 0x00000004) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code), str(root))


def verify_ready(root: Path, python: Path, identity: dict, spec_hashes: dict, packages: dict) -> dict:
    if root.is_symlink() or not root.is_dir() or (root / RECEIPT).is_symlink():
        raise ValueError("Existing target is not a ready installation directory")
    receipt = read_json(root / RECEIPT)
    if (receipt.get("schemaVersion") != 1 or receipt.get("status") != "converted-unvalidated"
            or receipt.get("specSha256") != spec_hashes or receipt.get("python") != identity
            or receipt.get("dependencies") != packages):
        raise ValueError("Existing installation receipt does not match this exact specification")
    if receipt.get("files") != inventory(root, python):
        raise ValueError("Existing installation contents differ from the receipt")
    return receipt


def prepare(root: Path, python: Path, *, verify_only: bool) -> dict:
    manifest, expected_packages, spec_hashes = load_spec()
    # The probe does not import site packages or write bytecode/caches.
    identity = probe_python(python, manifest, {"PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8"})
    if identity["basePrefix"] != identity["prefix"]:
        raise ValueError("--python must identify the base interpreter, not a virtual environment")
    if root.exists() or root.is_symlink():
        verify_ready(root, python, identity, spec_hashes, expected_packages)
        return {"status": "verified-converted-unvalidated", "root": str(root)}
    if verify_only:
        raise ValueError("Installation does not exist")
    with owned_stage(root) as stage:
        scratch = stage / "scratch"
        scratch.mkdir()
        env = process_env(scratch)
        uv = stage / "tools/uv"
        uv.parent.mkdir()
        print("Downloading and verifying uv", flush=True)
        archive = scratch / "uv.tar.gz"
        download(manifest["uv"]["url"], archive, manifest["uv"])
        extract_uv(archive, uv, manifest["uv"])
        uv_version = run([str(uv), "--version"], env, capture=True).strip()
        if not uv_version.startswith(f"uv {manifest['uv']['version']} ("):
            raise ValueError("Unexpected uv version identity")
        runtime = stage / "runtime"
        run([str(uv), "venv", "--no-project", "--no-config", "--no-python-downloads",
             "--relocatable", "--python", str(python), str(runtime)], env)
        runtime_python = runtime / "bin/python"
        if runtime_python.resolve() != python:
            raise ValueError("Virtual environment changed the exact interpreter")
        shutil.copytree(RESOURCES, stage / "spec", ignore=shutil.ignore_patterns("__pycache__"))
        print("Installing locked wheels into the private runtime", flush=True)
        run([str(uv), "pip", "sync", "--no-config", "--no-python-downloads",
             "--python", str(runtime_python), "--require-hashes", "--only-binary", ":all:",
             "--link-mode", "copy", "--strict", "--default-index", "https://pypi.org/simple",
             str(stage / "spec/requirements.lock")], env)
        packages = json.loads(run([str(runtime_python), "-I", "-B", "-c", PACKAGES], env, capture=True))
        if packages != expected_packages:
            raise ValueError("Installed distributions do not match the exact lock")
        source = stage / "source"
        repository = manifest["model"]["repository"]
        revision = manifest["model"]["revision"]
        for entry in manifest["model"]["files"]:
            print(f"Downloading and verifying {entry['path']}", flush=True)
            download(f"https://huggingface.co/{repository}/resolve/{revision}/{entry['path']}",
                     source / relative_path(entry["path"]), entry)
        print("Converting language weights to 8-bit; retaining bfloat16 vision weights", flush=True)
        run([str(runtime_python), "-I", "-B", str(stage / "spec/convert.py"),
             "--source", str(source), "--output", str(stage / "model-8bit"),
             "--manifest", str(stage / "spec/manifest.json")], process_env(scratch, offline=True))
        for entry in manifest["model"]["files"]:
            verify_file(source / relative_path(entry["path"]), entry)
        shutil.rmtree(scratch)
        receipt = {
            "schemaVersion": 1, "status": "converted-unvalidated",
            "createdAt": datetime.now(timezone.utc).isoformat(), "python": identity,
            "uv": {"versionOutput": uv_version, **manifest["uv"]},
            "dependencies": packages, "specSha256": spec_hashes,
            "conversion": read_json(stage / "model-8bit/conversion-check.json"),
            "files": inventory(stage, python),
        }
        write_json(stage / RECEIPT, receipt)
        verify_ready(stage, python, identity, spec_hashes, expected_packages)
        publish(stage, root)
    return {"status": "converted-unvalidated", "root": str(root)}


def cancelled(_signum: int, _frame: object) -> None:
    raise KeyboardInterrupt


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True, help="Absolute new destination; its parent must exist")
    parser.add_argument("--python", type=Path, required=True, help="Absolute path to existing CPython 3.14.10")
    parser.add_argument("--verify-only", action="store_true", help="Read and hash an existing installation; no downloads")
    args = parser.parse_args()
    if not args.root.is_absolute() or not args.python.is_absolute():
        parser.error("--root and --python must be absolute paths")
    if not args.root.name or args.root.name in (".", ".."):
        parser.error("--root must name a destination directory")
    try:
        root = args.root.parent.resolve(strict=True) / args.root.name
        python = args.python.resolve(strict=True)
    except OSError as error:
        parser.error(str(error))
    if not python.is_file():
        parser.error("--python must be an existing executable file")
    signal.signal(signal.SIGTERM, cancelled)
    try:
        print(json.dumps(prepare(root, python, verify_only=args.verify_only), ensure_ascii=False))
        return 0
    except KeyboardInterrupt:
        print("Preparation cancelled; owned staging removed", file=sys.stderr)
        return 130
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print(f"Preparation failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
