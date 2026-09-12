"""构建 R 的受限进程适配库，不链接 R 或引入额外运行时。"""

import base64
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    source = root / "resources/research-runtime/r-process.c"
    result = {"sourceHash": hashlib.sha256(source.read_bytes()).hexdigest(), "architectures": ["arm64", "x64"]}
    with tempfile.TemporaryDirectory(prefix="roc-r-process-build-") as temporary:
        slices = []
        for architecture, target in (("arm64", "arm64"), ("x64", "x86_64")):
            library = Path(temporary) / f"roc-research-r-process-{architecture}.dylib"
            subprocess.run(["/usr/bin/xcrun", "clang", "-arch", target, "-mmacosx-version-min=11.0", "-dynamiclib", "-O2", "-g0", "-fvisibility=hidden",
                            "-Wall", "-Wextra", "-Werror", "-Wl,-install_name,@rpath/roc-research-r-process.dylib", str(source), "-o", str(library)], check=True)
            slices.append(str(library))
        library = Path(temporary) / "roc-research-r-process.dylib"
        subprocess.run(["/usr/bin/xcrun", "lipo", "-create", *slices, "-output", str(library)], check=True)
        subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", str(library)], check=True)
        data = library.read_bytes()
        result.update({"sha256": hashlib.sha256(data).hexdigest(), "data": base64.b64encode(data).decode("ascii")})
    destination = source.with_name("r-process.lock.json")
    destination.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(destination)


if __name__ == "__main__":
    main()
