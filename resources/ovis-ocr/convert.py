"""Convert verified official sources; check weight metadata without inference."""

import argparse
import json
import shutil
import struct
from pathlib import Path


def check_conversion(output: Path) -> dict:
    config = json.loads((output / "config.json").read_text(encoding="utf-8"))
    quantization = config.get("quantization", {})
    if (config.get("model_type") != "qwen3_5" or quantization.get("bits") != 8
            or quantization.get("group_size") != 64 or quantization.get("mode") != "affine"):
        raise ValueError("Conversion did not produce the required Qwen3.5 affine 8-bit configuration")
    tensors = {}
    for file in sorted(output.glob("*.safetensors")):
        with file.open("rb") as stream:
            length_bytes = stream.read(8)
            if len(length_bytes) != 8:
                raise ValueError("Truncated safetensors file")
            length = struct.unpack("<Q", length_bytes)[0]
            if not 0 < length < 32 * 1024**2:
                raise ValueError("Unexpected safetensors header size")
            header = json.loads(stream.read(length))
        for name, metadata in header.items():
            if name == "__metadata__":
                continue
            if name in tensors:
                raise ValueError(f"Duplicate weight: {name}")
            start, end = metadata["data_offsets"]
            if not 0 <= start < end <= file.stat().st_size - 8 - length:
                raise ValueError(f"Invalid tensor data bounds: {name}")
            tensors[name] = metadata
    vision = {name: value for name, value in tensors.items() if name.startswith("vision_tower.")}
    if not vision or any(value["dtype"] != "BF16" for value in vision.values()):
        raise ValueError("Vision weights must remain unquantized bfloat16")
    scales = [name for name in tensors if name.startswith("language_model.") and name.endswith(".scales")]
    if not scales:
        raise ValueError("No quantized language weights found")
    for name in scales:
        weight = tensors.get(name.removesuffix(".scales") + ".weight", {})
        if weight.get("dtype") != "U32":
            raise ValueError(f"Missing packed language weight for {name}")
    return {
        "status": "converted-unvalidated", "inferenceValidated": False,
        "quantization": {"bits": 8, "group_size": 64, "mode": "affine", "method": "rtn"},
        "visionDtype": "bfloat16", "visionTensors": len(vision),
        "quantizedLanguageModules": len(scales), "totalTensors": len(tensors),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error("Conversion output must not exist")
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    options = {key: value for key, value in manifest["conversion"].items() if key != "visionPolicy"}
    from mlx_vlm.convert import convert

    convert(hf_path=str(args.source), mlx_path=str(args.output), **options)
    shutil.copyfile(args.source / "LICENSE", args.output / "LICENSE")
    for source in (args.source / "prompts").glob("*.txt"):
        target = args.output / "prompts" / source.name
        if not target.is_file() or target.read_bytes() != source.read_bytes():
            raise ValueError(f"Conversion changed a task prompt: {source.name}")
    report = check_conversion(args.output)
    (args.output / "conversion-check.json").write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
