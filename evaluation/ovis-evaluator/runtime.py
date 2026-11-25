"""Private evaluator paths and child-process environment; never activate globally."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

REVISION = "0ff4f3cfbcd45636cc6d9933a551036893f0d83c"


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def configure(root: Path, *, offline: bool = True) -> Path:
    root = root.absolute()
    source = root / f"OmniDocBench-{REVISION}"
    tex = root / "texlive/2025"
    tex_bin = tex / "bin/universal-darwin"
    cache = root / "cache"
    for name in ["matplotlib", "huggingface", "nltk", "xdg", "tmp"]:
        (cache / name).mkdir(parents=True, exist_ok=True)
    os.environ.update({
        "PATH": os.pathsep.join([str(root / "native/bin"), str(tex_bin), "/usr/bin", "/bin"]),
        "CDM_TEXLIVE_ROOT": str(tex), "CDM_TEXLIVE_BIN": str(tex_bin),
        "CDM_PDFLATEX": str(tex_bin / "pdflatex"), "CDM_KPSEWHICH": str(tex_bin / "kpsewhich"),
        "CDM_CJK_FONT": "gkai", "CDM_CJK_CHAR_LEVEL": "1", "CDM_SAVE_VIS": "1",
        "MPLCONFIGDIR": str(cache / "matplotlib"), "HF_HOME": str(cache / "huggingface"),
        "HF_MODULES_CACHE": str(cache / "huggingface/modules"),
        "HUGGINGFACE_HUB_CACHE": str(cache / "huggingface/hub"),
        "NLTK_DATA": str(cache / "nltk"), "XDG_CACHE_HOME": str(cache / "xdg"),
        "TMPDIR": str(cache / "tmp"), "HF_HUB_OFFLINE": "1" if offline else "0",
        "HF_DATASETS_OFFLINE": "1" if offline else "0", "HF_EVALUATE_OFFLINE": "1" if offline else "0",
        "PYTHONDONTWRITEBYTECODE": "1", "OMP_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1",
        "MKL_NUM_THREADS": "1", "VECLIB_MAXIMUM_THREADS": "1",
        "OMNIDOCBENCH_CDM_WORKERS": "1", "OMNIDOCBENCH_TEDS_WORKERS": "1",
    })
    lock = json.loads((Path(__file__).parent / "environment.lock.json").read_text(encoding="utf-8"))
    for file in lock["officialSource"]["files"]:
        path = source / file["path"]
        if sha256(path) != file["sha256"]:
            raise ValueError(f"official evaluator source changed: {path}")
    if offline:
        for file in lock.get("offlineResources", {}).get("files", []):
            path = root / file["path"]
            if path.stat().st_size != file["bytes"] or sha256(path) != file["sha256"]:
                raise ValueError(f"offline resource changed: {path}")
    return source
