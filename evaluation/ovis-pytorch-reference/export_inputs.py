"""Export input tensors without loading model weights or scheduling GPU kernels."""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
from pathlib import Path
from types import SimpleNamespace

from common import ROOT, CONFIG_PATH, digest, formatted_prompt, official_processor, require_offline, verified_inputs, write_json


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", choices=("mlx", "pytorch"), required=True)
    parser.add_argument("--installation", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    require_offline()
    config, source, prompt = verified_inputs(args.installation)
    args.output.mkdir()
    import numpy as np
    from PIL import Image

    if args.backend == "mlx":
        import mlx.core as mx
        mx.set_default_device(mx.cpu)
        from mlx_vlm.models.qwen3_5 import Qwen3VLProcessor
        from mlx_vlm.prompt_utils import apply_chat_template
        from mlx_vlm.utils import prepare_inputs, should_add_special_tokens
        processor = Qwen3VLProcessor.from_pretrained(source, local_files_only=True, trust_remote_code=False)
        formatted = apply_chat_template(processor, SimpleNamespace(model_type="qwen3_5"), prompt,
                                        num_images=1, enable_thinking=False, add_generation_prompt=True)
    else:
        import torch
        torch.set_num_threads(1)
        torch.set_num_interop_threads(1)
        processor = official_processor(source)
        formatted = formatted_prompt(processor, prompt, config)
    if hashlib.sha256(formatted.encode()).hexdigest() != config["formattedPromptSha256"]:
        raise ValueError("Formatted prompt changed")
    (args.output / "formatted-prompt.txt").write_text(formatted, encoding="utf-8")
    report = {"backend": args.backend, "configSha256": digest(CONFIG_PATH),
              "scriptSha256": digest(Path(__file__)), "commonSha256": digest(Path(__file__).with_name("common.py")),
              "processorClass": f"{type(processor).__module__}.{type(processor).__name__}",
              "imageProcessorClass": f"{type(processor.image_processor).__module__}.{type(processor.image_processor).__name__}",
              "formattedPromptSha256": digest(args.output / "formatted-prompt.txt"),
              "device": "cpu", "modelLoaded": False,
              "packages": {d.metadata["Name"]: d.version for d in importlib.metadata.distributions()}, "pages": []}
    for page in config["pages"]:
        path = ROOT / page["image"]
        if args.backend == "mlx":
            inputs = prepare_inputs(processor, images=[str(path)], prompts=formatted,
                                    add_special_tokens=should_add_special_tokens("qwen3_5", processor),
                                    min_pixels=config["settings"]["minPixels"],
                                    max_pixels=config["settings"]["maxPixels"])
            arrays = {key: np.asarray(value) for key, value in inputs.items() if value is not None}
        else:
            with Image.open(path) as image:
                inputs = processor(text=[formatted], images=[image.convert("RGB")], return_tensors="pt",
                                   add_special_tokens=False,
                                   images_kwargs={"size": {"shortest_edge": config["settings"]["minPixels"],
                                                           "longest_edge": config["settings"]["maxPixels"]}})
            arrays = {key: value.cpu().numpy() for key, value in inputs.items()}
        filename = args.output / f"{page['id']}.npz"
        np.savez(filename, **arrays)
        tensors = {key: {"shape": list(value.shape), "dtype": str(value.dtype),
                         "sha256": hashlib.sha256(value.tobytes()).hexdigest()} for key, value in arrays.items()}
        row = {"id": page["id"], "imageSha256": page["sha256"], "fileSha256": digest(filename), "tensors": tensors}
        report["pages"].append(row)
        print(page["id"], tensors, flush=True)
    write_json(args.output / "report.json", report)


if __name__ == "__main__":
    main()
