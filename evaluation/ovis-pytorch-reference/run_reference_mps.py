"""Run three frozen pages with the independent official PyTorch model on MPS with CPU fallback disabled."""
from __future__ import annotations

import argparse
from collections import Counter
import ctypes
from datetime import datetime, timezone
import importlib.metadata
import json
import os
from pathlib import Path
import resource
import signal
import subprocess
import sys
import threading
import time

from common import ROOT, CONFIG_PATH as CPU_CONFIG_PATH, digest, formatted_prompt, official_processor, require_offline, verified_inputs, write_json


CONFIG_PATH = Path(__file__).with_name("parity-mps.json")

def pressure_level() -> int:
    value = ctypes.c_int()
    length = ctypes.c_size_t(ctypes.sizeof(value))
    library = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    if library.sysctlbyname(b"kern.memorystatus_vm_pressure_level", ctypes.byref(value),
                           ctypes.byref(length), None, 0) != 0:
        raise OSError(ctypes.get_errno(), "Cannot measure macOS memory pressure")
    return value.value


def rss_bytes() -> int:
    class TaskInfo(ctypes.Structure):
        _fields_ = [("values", ctypes.c_uint64 * 6), ("counters", ctypes.c_int32 * 12)]
    info = TaskInfo()
    library = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    size = library.proc_pidinfo(os.getpid(), 4, 0, ctypes.byref(info), ctypes.sizeof(info))
    if size != ctypes.sizeof(info):
        raise OSError(ctypes.get_errno(), "Cannot measure process RSS")
    return int(info.values[1])


class MemoryGuard:
    """Stop this MPS reference on warning/critical pressure; preserve the MLX run."""
    def __init__(self, path: Path):
        self.path = path
        self.stop = threading.Event()
        self.failure = None
        self.start_rss = rss_bytes()
        self.peak_rss = self.start_rss
        self.thread = threading.Thread(target=self.monitor, daemon=True)

    def monitor(self):
        try:
            with self.path.open("x", encoding="utf-8") as stream:
                while not self.stop.is_set():
                    current, pressure = rss_bytes(), pressure_level()
                    self.peak_rss = max(self.peak_rss, current)
                    stream.write(json.dumps({"time": time.time(), "rssBytes": current, "pressureLevel": pressure}) + "\n")
                    stream.flush()
                    if pressure != 1:
                        raise RuntimeError(f"macOS memory pressure is not normal: {pressure}")
                    self.stop.wait(1)
        except Exception as error:
            self.failure = str(error)
            os.kill(os.getpid(), signal.SIGINT)

    def __enter__(self):
        if pressure_level() != 1:
            raise RuntimeError("Memory pressure is not normal before reference start")
        self.thread.start()
        return self

    def __exit__(self, *_args):
        self.stop.set()
        self.thread.join()


def run(args) -> int:
    require_offline()
    cpu_config, source, prompt = verified_inputs(args.installation)
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    for key in ("modelRevision", "installationReceiptSha256", "promptSha256", "formattedPromptSha256", "pages", "inputComparison", "outputComparison"):
        if config[key] != cpu_config[key]:
            raise ValueError(f"MPS experiment must retain frozen source/input/comparison identity: {key}")
    expected_settings = {**cpu_config["settings"], "device": "mps", "mpsCpuFallback": False}
    if config["settings"] != expected_settings:
        raise ValueError("Only MPS device and disabled fallback differ from frozen CPU settings")
    committed = subprocess.run(["git", "show", "HEAD:evaluation/ovis-pytorch-reference/parity-mps.json"],
                               cwd=ROOT, check=True, capture_output=True).stdout
    if committed != CONFIG_PATH.read_bytes():
        raise ValueError("Parity configuration must match committed HEAD before generation")
    expected_inputs = json.loads((args.inputs / "report.json").read_text())
    if expected_inputs["backend"] != "pytorch" or expected_inputs["configSha256"] != digest(CPU_CONFIG_PATH):
        raise ValueError("Input preflight belongs to a different backend or configuration")
    python_receipt = json.loads((args.installation / "receipt.json").read_text())["python"]
    if digest(Path(sys.executable).resolve()) != python_receipt["executableSha256"]:
        raise ValueError("Reference interpreter differs from frozen Python binary")
    if digest(Path(python_receipt["sharedLibrary"])) != python_receipt["sharedLibrarySha256"]:
        raise ValueError("Reference interpreter shared library changed")
    for package, version in {"torch": "2.15.0", "torchvision": "0.29.2", "transformers": "5.24.1",
                             "tokenizers": "0.23.3", "safetensors": "0.8.0", "numpy": "2.5.5", "pillow": "13.0.0"}.items():
        if importlib.metadata.version(package) != version:
            raise ValueError(f"Reference dependency changed: {package}")
    args.output.mkdir()
    report = {"schemaVersion": 1, "status": "running", "scope": config["scope"],
              "createdAt": datetime.now(timezone.utc).isoformat(), "configurationSha256": digest(CONFIG_PATH),
              "runnerSha256": digest(Path(__file__)), "commonSha256": digest(Path(__file__).with_name("common.py")),
              "requirementsLockSha256": digest(Path(__file__).with_name("requirements.lock")),
              "settings": config["settings"], "network": "denied-by-seatbelt", "hostLoad": "mixed-host-load",
              "performanceQualification": False, "pages": []}
    guard = MemoryGuard(args.output / "memory.jsonl")
    try:
        with guard:
            os.environ.update(OMP_NUM_THREADS="1", OPENBLAS_NUM_THREADS="1", MKL_NUM_THREADS="1",
                              VECLIB_MAXIMUM_THREADS="1", PYTORCH_ENABLE_MPS_FALLBACK="0")
            import numpy as np
            import torch
            from PIL import Image
            from transformers import Qwen3_5ForConditionalGeneration
            from transformers.generation.streamers import BaseStreamer

            torch.set_num_threads(1)
            torch.set_num_interop_threads(1)
            torch.manual_seed(0)
            if not torch.backends.mps.is_available():
                raise RuntimeError("PyTorch MPS is unavailable; no fallback permitted")
            processor = official_processor(source)
            formatted = formatted_prompt(processor, prompt, config)
            (args.output / "formatted-prompt.txt").write_text(formatted, encoding="utf-8")
            started = time.perf_counter()
            model = Qwen3_5ForConditionalGeneration.from_pretrained(
                source, dtype=torch.bfloat16, local_files_only=True, trust_remote_code=False,
                attn_implementation=config["settings"]["attentionImplementation"])
            model = model.to("mps")
            model.eval()
            torch.mps.synchronize()
            if any(parameter.device.type != "mps" or parameter.dtype != torch.bfloat16 for parameter in model.parameters()):
                raise ValueError("MPS BF16 model placement/precision was violated")
            report["loadSeconds"] = time.perf_counter() - started
            report["parameterDtypes"] = dict(Counter(str(p.dtype) for p in model.parameters()))
            report["modelClass"] = f"{type(model).__module__}.{type(model).__name__}"
            report["modelSourceSha256"] = digest(Path(sys.modules[type(model).__module__].__file__))
            report["torchThreads"] = torch.get_num_threads()
            report["torchInteropThreads"] = torch.get_num_interop_threads()
            report["packages"] = {d.metadata["Name"]: d.version for d in importlib.metadata.distributions()}
            write_json(args.output / "loaded.json", report)

            class Tokens(BaseStreamer):
                def __init__(self, input_ids, path):
                    self.prompt = input_ids[0].tolist()
                    self.seen_prompt = False
                    self.ids = []
                    self.stream = path.open("x", encoding="utf-8")

                def put(self, value):
                    ids = value.reshape(-1).tolist()
                    if not self.seen_prompt:
                        if ids != self.prompt:
                            raise ValueError("Streamer initial token evidence differs from prompt")
                        self.seen_prompt = True
                        return
                    self.ids.extend(ids)
                    self.stream.write(json.dumps(ids) + "\n")
                    self.stream.flush()

                def end(self):
                    self.stream.flush()

            for page, frozen in zip(config["pages"], expected_inputs["pages"], strict=True):
                if page["id"] != frozen["id"]:
                    raise ValueError("Input preflight page order differs")
                expected_path = args.inputs / f"{page['id']}.npz"
                if digest(expected_path) != frozen["fileSha256"]:
                    raise ValueError("Preflight tensors changed")
                with Image.open(ROOT / page["image"]) as image:
                    inputs = processor(text=[formatted], images=[image.convert("RGB")], return_tensors="pt",
                                       add_special_tokens=False,
                                       images_kwargs={"size": {"shortest_edge": config["settings"]["minPixels"],
                                                               "longest_edge": config["settings"]["maxPixels"]}})
                with np.load(expected_path) as expected:
                    if set(inputs) != set(expected.files) or any(
                            not np.array_equal(inputs[k].numpy(), expected[k]) for k in inputs):
                        raise ValueError("Actual inference tensors differ from frozen preflight")
                inputs = {key: value.to("mps") for key, value in inputs.items()}
                tokens = Tokens(inputs["input_ids"], args.output / f"{page['id']}.tokens.jsonl")
                started = time.perf_counter()
                completed = False
                try:
                    torch.manual_seed(0)
                    with torch.inference_mode():
                        output = model.generate(**inputs, do_sample=False,
                                                max_new_tokens=config["settings"]["maxNewTokens"],
                                                eos_token_id=config["settings"]["eosTokenIds"],
                                                streamer=tokens)
                    torch.mps.synchronize()
                    generated = output[0, inputs["input_ids"].shape[1]:].tolist()
                    if generated != tokens.ids:
                        raise ValueError("Returned and streamed generated token evidence differs")
                    completed = True
                finally:
                    tokens.stream.close()
                    eos = bool(tokens.ids and tokens.ids[-1] in config["settings"]["eosTokenIds"])
                    # Preserve the EOS-inclusive decode separately. Only remove its final
                    # control token from content, matching MLX's pre-detokenization EOS stop.
                    decoded = processor.tokenizer.decode(tokens.ids, skip_special_tokens=False,
                                                         clean_up_tokenization_spaces=False)
                    content_ids = tokens.ids[:-1] if eos else tokens.ids
                    raw = processor.tokenizer.decode(content_ids, skip_special_tokens=False,
                                                     clean_up_tokenization_spaces=False)
                    (args.output / f"{page['id']}.decoded-with-eos.txt").write_text(decoded, encoding="utf-8")
                    raw_path = args.output / f"{page['id']}.raw.txt"
                    raw_path.write_text(raw, encoding="utf-8")
                    write_json(args.output / f"{page['id']}.tokens.json", tokens.ids)
                    row = {"mpsAllocatedBytes": torch.mps.current_allocated_memory(), "mpsDriverAllocatedBytes": torch.mps.driver_allocated_memory(), "id": page["id"], "imageSha256": page["sha256"], "completed": completed,
                           "seconds": time.perf_counter() - started, "generationTokens": len(tokens.ids),
                           "eosObserved": eos, "lastTokenId": tokens.ids[-1] if tokens.ids else None,
                           "truncated": completed and not eos, "rawSha256": digest(raw_path),
                           "processLifetimePeakRssBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}
                    write_json(args.output / f"{page['id']}.metrics.json", row)
                    report["pages"].append(row)
                    print(json.dumps(row), flush=True)
            report["status"] = "completed" if all(p["eosObserved"] for p in report["pages"]) else "truncated-output"
    except BaseException as error:
        report["status"] = "stopped-memory-pressure" if guard.failure else "failed-or-interrupted"
        report["error"] = guard.failure or f"{type(error).__name__}: {error}"
        raise
    finally:
        report["rssStartBytes"] = guard.start_rss
        report["rssSampledPeakBytes"] = guard.peak_rss
        report["rssIncreaseFromStartBytes"] = guard.peak_rss - guard.start_rss
        write_json(args.output / "report.json", report)
    return 0 if report["status"] == "completed" else 2


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--installation", required=True, type=Path)
    parser.add_argument("--inputs", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, lambda *_: signal.raise_signal(signal.SIGINT))
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
