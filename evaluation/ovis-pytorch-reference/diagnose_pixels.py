"""One-variable pixel diagnosis; its outputs are ineligible for model acceptance."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import signal
import subprocess

from common import ROOT, digest
from run_reference_mps import run

CONFIG = Path(__file__).with_name("diagnostic-pixels.json")


class PixelDiagnostic:
    def __init__(self) -> None:
        self.configuration = json.loads(CONFIG.read_text())
        committed = subprocess.run(["git", "show", "HEAD:evaluation/ovis-pytorch-reference/diagnostic-pixels.json"],
                                   cwd=ROOT, check=True, capture_output=True).stdout
        if CONFIG.read_bytes() != committed or self.configuration["adoptionEligible"] is not False:
            raise ValueError("Diagnostic contract must be committed and ineligible for acceptance")
        for row in self.configuration["identities"].values():
            if digest(ROOT / row["path"]) != row["sha256"]:
                raise ValueError(f"Diagnostic frozen evidence changed: {row['path']}")
        self.input_root = (ROOT / self.configuration["identities"]["mlxInputReport"]["path"]).parent
        report = json.loads((self.input_root / "report.json").read_text())
        if report["backend"] != "mlx":
            raise ValueError("Diagnostic requires exported MLX inputs")
        self.rows = {row["id"]: row for row in report["pages"]}
        self.identity = {"configurationSha256": digest(CONFIG), "scriptSha256": digest(Path(__file__)),
                         "intervention": self.configuration["intervention"], "pages": []}

    def replace(self, inputs, page: dict) -> None:
        import numpy as np
        import torch

        path = self.input_root / f"{page['id']}.npz"
        row = self.rows[page["id"]]
        if digest(path) != row["fileSha256"] or page["sha256"] != row["imageSha256"]:
            raise ValueError("Diagnostic input tensor or image identity changed")
        with np.load(path, allow_pickle=False) as candidate:
            if set(candidate.files) != {"input_ids", "attention_mask", "image_grid_thw", "pixel_values"}:
                raise ValueError("Unexpected MLX input tensor keys")
            for key in ("input_ids", "attention_mask", "image_grid_thw"):
                if not np.array_equal(candidate[key], inputs[key].numpy()):
                    raise ValueError(f"Pixel-only diagnosis requires identical {key}")
            original = inputs["pixel_values"].numpy()
            replacement = candidate["pixel_values"]
            if original.shape != replacement.shape or original.dtype != replacement.dtype or not np.isfinite(replacement).all():
                raise ValueError("Diagnostic pixel layout differs or has nonfinite values")
            original_bf16 = inputs["pixel_values"].to(torch.bfloat16)
            pixels = torch.from_numpy(replacement.copy())
            replacement_bf16 = pixels.to(torch.bfloat16)
            self.identity["pages"].append({"id": page["id"], "inputFileSha256": row["fileSha256"],
                "float32MaxAbsoluteDifference": float(np.abs(original - replacement).max()),
                "bf16DifferingComponents": int((original_bf16 != replacement_bf16).sum()),
                "bf16MaxAbsoluteDifference": float((original_bf16.float() - replacement_bf16.float()).abs().max())})
            inputs["pixel_values"] = pixels


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--installation", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    diagnostic = PixelDiagnostic()
    args.inputs = (ROOT / diagnostic.configuration["identities"]["officialInputReport"]["path"]).parent
    signal.signal(signal.SIGTERM, lambda *_: signal.raise_signal(signal.SIGINT))
    return run(args, pixel_diagnostic=diagnostic)


if __name__ == "__main__":
    raise SystemExit(main())
