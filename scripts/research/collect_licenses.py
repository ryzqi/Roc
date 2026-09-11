"""在目标解释器中记录实际安装包及其随包许可证位置。"""

from __future__ import annotations

import importlib.metadata
import json
from pathlib import Path
import sys


def collect(root: Path) -> list[dict]:
    records = []
    for distribution in importlib.metadata.distributions():
        metadata = distribution.metadata
        licenses = []
        for file in distribution.files or []:
            if (any(word in file.name.lower() for word in ("license", "copying", "notice", "copyright"))
                    or any(part.lower() in {"licenses", "license", "build_licenses", "notices"} for part in file.parts)):
                path = Path(distribution.locate_file(file)).resolve()
                if path.is_file() and path.is_relative_to(root):
                    licenses.append(path.relative_to(root).as_posix())
        records.append({"name": metadata["Name"], "version": distribution.version,
                        "licenseExpression": metadata.get("License-Expression"),
                        "license": metadata.get("License"),
                        "licenseClassifiers": [item for item in metadata.get_all("Classifier", []) if item.startswith("License ::")],
                        "projectUrls": metadata.get_all("Project-URL", []), "licenseFiles": sorted(licenses)})
    return sorted(records, key=lambda item: item["name"].lower())


if __name__ == "__main__":
    root = Path(sys.argv[1]).resolve(strict=True)
    print(json.dumps(collect(root), ensure_ascii=False, indent=2))
