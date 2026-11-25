"""Select immutable Apple Silicon wheel URLs from the already frozen Ovis lock.

Run with the Ovis Python 3.14 runtime (packaging is already hash-locked there).
This reads PyPI metadata; it never installs packages or changes the source lock.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse

from packaging.specifiers import SpecifierSet
from packaging.tags import compatible_tags, cpython_tags, mac_platforms
from packaging.utils import canonicalize_name, parse_wheel_filename

LOCK = Path(__file__).resolve().parents[2] / "resources/ovis-ocr/requirements.lock"
TARGET = {"python": "3.14.10", "implementation": "cpython", "abi": "cp314",
          "system": "Darwin", "machine": "arm64", "minimumMacOS": "15.0"}


def read_lock(content: str) -> dict[str, tuple[str, set[str]]]:
    result = {}
    for line in content.replace("\\\n", " ").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        match = re.fullmatch(r"([a-z0-9][a-z0-9-]*)==([^\s;]+)((?:\s+--hash=sha256:[0-9a-f]{64})+)", line)
        if not match or match[1] in result:
            raise ValueError("Expected unique exact pins with hashes only")
        result[match[1]] = (match[2], set(re.findall(r"sha256:([0-9a-f]{64})", match[3])))
    if not result:
        raise ValueError("Empty dependency lock")
    return result


def supported_tags() -> dict[object, int]:
    platforms = list(mac_platforms((15, 0), "arm64"))
    tags = [*cpython_tags((3, 14), ["cp314"], platforms),
            *compatible_tags((3, 14), "cp314", platforms)]
    return {tag: index for index, tag in reversed(list(enumerate(tags)))}


def select_wheel(name: str, version: str, hashes: set[str], metadata: dict) -> dict:
    if (canonicalize_name(metadata["info"]["name"]) != name
            or metadata["info"]["version"] != version):
        raise ValueError(f"Unexpected release identity: {name}")
    ranks = supported_tags()
    candidates = []
    for item in metadata["urls"]:
        filename = item["filename"]
        if item["packagetype"] != "bdist_wheel" or item.get("yanked"):
            continue
        wheel_name, wheel_version, _, tags = parse_wheel_filename(filename)
        if wheel_name != name or str(wheel_version) != version:
            raise ValueError(f"Wheel identity differs from release: {filename}")
        matching = tags & ranks.keys()
        if not matching or item["digests"]["sha256"] not in hashes:
            continue
        if item.get("requires_python") and not SpecifierSet(item["requires_python"]).contains(TARGET["python"]):
            continue
        url = urlparse(item["url"])
        if (url.scheme != "https" or url.netloc != "files.pythonhosted.org"
                or url.query or url.fragment or url.path.rsplit("/", 1)[-1] != filename
                or not re.fullmatch(r"[A-Za-z0-9_.+-]+\.whl", filename)
                or type(item["size"]) is not int or not 0 < item["size"] <= 512 * 1024**2):
            raise ValueError(f"Invalid wheel download: {name}")
        candidates.append((min(ranks[tag] for tag in matching), filename, {
            "name": name, "version": version, "filename": filename, "url": item["url"],
            "size": item["size"], "sha256": item["digests"]["sha256"],
        }))
    if not candidates:
        raise ValueError(f"No locked CPython 3.14/macOS 15 arm64 wheel: {name}")
    return min(candidates, key=lambda item: item[:2])[2]


def fetch_wheel(item: tuple[str, tuple[str, set[str]]]) -> dict:
    name, (version, hashes) = item
    with urllib.request.urlopen(f"https://pypi.org/pypi/{name}/{version}/json", timeout=60) as response:
        data = response.read(8 * 1024**2 + 1)
    if len(data) > 8 * 1024**2:
        raise ValueError("PyPI release metadata too large")
    return select_wheel(name, version, hashes, json.loads(data))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    lock = LOCK.read_bytes()
    with ThreadPoolExecutor(max_workers=6) as pool:
        wheels = list(pool.map(fetch_wheel, sorted(read_lock(lock.decode()).items())))
    result = {"schemaVersion": 1, "target": TARGET,
              "requirementsSha256": hashlib.sha256(lock).hexdigest(),
              "bytes": sum(wheel["size"] for wheel in wheels), "wheels": wheels}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as output:
        json.dump(result, output, indent=2, ensure_ascii=False)
        output.write("\n")
    print(json.dumps({"wheels": len(wheels), "bytes": result["bytes"]}))


if __name__ == "__main__":
    main()
