"""Frozen local inputs shared by independent implementation comparison tools."""
from __future__ import annotations

import ctypes
import hashlib
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = Path(__file__).with_name("parity.json")


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_json(path: Path, value: object) -> None:
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, ensure_ascii=False, allow_nan=False)
        stream.write("\n")


def require_offline() -> None:
    library = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    check = library.sandbox_check
    check.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int)
    check.restype = ctypes.c_int
    for operation in (b"network-outbound", b"network-inbound"):
        if check(os.getpid(), operation, 0) != 1:
            raise RuntimeError("OS network-deny sandbox is required")
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
                      HF_HUB_DISABLE_TELEMETRY="1", TOKENIZERS_PARALLELISM="false")


def verified_inputs(installation: Path) -> tuple[dict, Path, str]:
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    receipt_path = installation / "receipt.json"
    if digest(receipt_path) != config["installationReceiptSha256"]:
        raise ValueError("Model installation receipt changed")
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    expected = {name: row for name, row in receipt["files"].items()
                if name == "source" or name.startswith("source/")}
    actual = {"source"} | {p.relative_to(installation).as_posix()
                           for p in (installation / "source").rglob("*")}
    if actual != set(expected):
        raise ValueError("Official source file set changed")
    for name, row in expected.items():
        path = installation / name
        if path.is_symlink():
            raise ValueError(f"Unexpected model source symlink: {name}")
        if row["type"] == "file" and digest(path) != row["sha256"]:
            raise ValueError(f"Official model source changed: {name}")
        if row["type"] == "directory" and not path.is_dir():
            raise ValueError(f"Official model directory changed: {name}")
    source = installation / "source"
    prompt = source / "prompts/document_structured.txt"
    if digest(prompt) != config["promptSha256"]:
        raise ValueError("Official task prompt changed")
    for page in config["pages"]:
        path = ROOT / page["image"]
        if path.is_symlink() or digest(path) != page["sha256"]:
            raise ValueError(f"Frozen page changed: {page['id']}")
    return config, source, prompt.read_text(encoding="utf-8")


def official_processor(source: Path):
    from transformers import AutoImageProcessor, AutoProcessor

    processor = AutoProcessor.from_pretrained(source, local_files_only=True, trust_remote_code=False)
    # The MLX port uses Pillow bicubic. Select Transformers' own PIL implementation,
    # independently executing its normalization/patching/token expansion.
    processor.image_processor = AutoImageProcessor.from_pretrained(
        source, local_files_only=True, trust_remote_code=False, backend="pil")
    return processor


def formatted_prompt(processor, prompt: str, config: dict) -> str:
    value = processor.tokenizer.apply_chat_template(
        [{"role": "user", "content": [{"type": "image"}, {"type": "text", "text": prompt}]}],
        tokenize=False, add_generation_prompt=True, enable_thinking=False)
    if hashlib.sha256(value.encode()).hexdigest() != config["formattedPromptSha256"]:
        raise ValueError("Formatted official prompt differs from frozen MLX prompt")
    return value
