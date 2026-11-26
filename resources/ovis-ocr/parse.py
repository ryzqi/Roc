"""Offline OvisOCR3 8-bit document parser, preserving raw output and EOS evidence."""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import importlib.metadata
import json
import os
import platform
import re
import resource
import signal
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

REVISION = "702a71f233a208be050b12779ee29fdd1eb2dab3"
PROMPT_SHA256 = "1b6139ec72888e087c8af75f2e2dfb78b425e15ae1c1529940b96137613d1db1"
OFFLINE_PROFILE = "(version 1)(allow default)(deny network*)"
MAX_TOKENS = 16384
MIN_PIXELS = 448 * 448
MAX_PIXELS = 2880 * 2880
CATEGORIES = frozenset((
    "abstract", "algorithm", "aside_text", "chart", "content", "display_formula",
    "doc_title", "figure_title", "footer", "footer_image", "footnote", "formula_number",
    "header", "header_image", "image", "inline_formula", "number", "paragraph_title",
    "reference_content", "seal", "table", "text", "vertical_text", "vision_footnote",
))


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_json(path: Path, value: object) -> None:
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")


def strict_json(raw: str) -> object:
    def pairs(items: list[tuple[str, object]]) -> dict:
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError(f"Duplicate JSON key: {key}")
            result[key] = value
        return result

    def constant(value: str) -> None:
        raise ValueError(f"Non-JSON number: {value}")

    return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)


def validate_document(raw: str) -> tuple[list | None, list[str]]:
    """No fence removal, JSON repair, coordinate clipping or field coercion."""
    try:
        blocks = strict_json(raw)
    except (ValueError, RecursionError) as error:
        return None, [f"json_invalid:{error}"]
    if not isinstance(blocks, list):
        return None, ["document_not_array"]
    errors = []
    for index, block in enumerate(blocks):
        prefix = f"block[{index}]"
        if not isinstance(block, dict) or set(block) != {"bbox", "category", "content"}:
            errors.append(f"{prefix}:exact_fields_required")
            continue
        bbox = block["bbox"]
        if (not isinstance(bbox, list) or len(bbox) != 4
                or any(type(value) is not int or not 0 <= value < 1000 for value in bbox)):
            errors.append(f"{prefix}:bbox_must_be_four_integers_in_0_999")
        elif bbox[0] >= bbox[2] or bbox[1] >= bbox[3]:
            errors.append(f"{prefix}:bbox_must_have_positive_area")
        if not isinstance(block["category"], str) or block["category"] not in CATEGORIES:
            errors.append(f"{prefix}:unknown_category")
        if not isinstance(block["content"], str):
            errors.append(f"{prefix}:content_not_string")
    return blocks, errors


def termination(finish_reason: str | None, token_ids: list[int], token_count: int,
                eos_ids: list[int]) -> dict:
    errors = []
    if (not isinstance(token_ids, list) or any(type(token) is not int for token in token_ids)
            or type(token_count) is not int or len(token_ids) != token_count):
        errors.append("token_evidence_invalid")
    last = token_ids[-1] if isinstance(token_ids, list) and token_ids else None
    eos = last in eos_ids
    if finish_reason not in ("stop", "length"):
        errors.append("finish_reason_missing_or_unknown")
    if finish_reason == "stop" and not eos:
        errors.append("stop_without_official_eos")
    if finish_reason == "length":
        errors.append("token_budget_exhausted")
    if token_count > MAX_TOKENS:
        errors.append("token_budget_exceeded")
    return {"finishReason": finish_reason, "eosObserved": eos, "lastTokenId": last,
            "truncated": finish_reason == "length", "errors": errors}


def read_pages(path: Path) -> list[dict]:
    document = strict_json(path.read_text(encoding="utf-8"))
    if (not isinstance(document, dict) or set(document) != {"schemaVersion", "pages"}
            or document["schemaVersion"] != 1 or not isinstance(document["pages"], list)
            or not document["pages"]):
        raise ValueError("Pages manifest requires schemaVersion=1 and nonempty pages")
    pages, seen = [], set()
    for page in document["pages"]:
        if not isinstance(page, dict) or set(page) != {"id", "image", "sha256"}:
            raise ValueError("Each page requires exactly id, image and sha256")
        if not isinstance(page["id"], str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", page["id"]):
            raise ValueError("Page id must be a safe unique filename")
        if page["id"] in seen or not isinstance(page["image"], str):
            raise ValueError("Duplicate page id or invalid image path")
        image = Path(page["image"])
        if not image.is_absolute() or not image.is_file() or image.is_symlink():
            raise ValueError("Images must be absolute existing regular local files")
        if not isinstance(page["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", page["sha256"]):
            raise ValueError("Page SHA256 must be explicit")
        if digest(image) != page["sha256"]:
            raise ValueError(f"Page bytes changed: {page['id']}")
        pages.append({**page, "image": str(image.resolve())})
        seen.add(page["id"])
    return pages


def verify_installation(root: Path) -> tuple[Path, str, dict]:
    receipt = strict_json((root / "receipt.json").read_text(encoding="utf-8"))
    if not isinstance(receipt, dict) or receipt.get("status") != "installed" or receipt.get("schemaVersion") != 2:
        raise ValueError("Expected a complete preparation receipt")
    manifest = strict_json((root / "spec/prequantized.lock.json").read_text(encoding="utf-8"))
    if manifest["model"]["revision"] != REVISION:
        raise ValueError("Unexpected official model revision")
    if platform.python_version() != "3.14.10" or Path(sys.prefix).resolve() != (root / "runtime").resolve():
        raise ValueError("Run this CLI with the installation's CPython 3.14.10 runtime/bin/python")
    python = receipt["python"]
    if digest(Path(sys.executable).resolve()) != python["executableSha256"]:
        raise ValueError("Interpreter bytes changed")
    if python.get("sharedLibrary") and digest(Path(python["sharedLibrary"])) != python["sharedLibrarySha256"]:
        raise ValueError("Interpreter shared library changed")
    model_name = "model-8bit"
    roots = {"runtime", model_name, "spec"}
    expected = {name: entry for name, entry in receipt["files"].items() if name.split("/")[0] in roots}
    actual = set()
    for area in sorted(roots):
        base = root / area
        if base.is_symlink() or not base.is_dir():
            raise ValueError(f"Invalid installation directory: {area}")
        actual.add(area)
        for folder, directories, files in os.walk(base, followlinks=False):
            actual.update((Path(folder) / name).relative_to(root).as_posix() for name in directories + files)
    if actual != set(expected):
        raise ValueError("Installation file set changed")
    for name, entry in expected.items():
        path = root / name
        if entry["type"] == "file":
            if path.is_symlink() or not path.is_file() or digest(path) != entry["sha256"]:
                raise ValueError(f"Installation file changed: {name}")
        elif entry["type"] == "symlink":
            if not path.is_symlink() or os.readlink(path) != entry["target"]:
                raise ValueError(f"Installation link changed: {name}")
        elif not path.is_dir() or path.is_symlink():
            raise ValueError(f"Installation directory changed: {name}")
    if importlib.metadata.version("mlx-vlm") != "0.8.1" or importlib.metadata.version("mlx") != "0.32.5":
        raise ValueError("Unexpected MLX runtime versions")
    prompt_path = root / "model-8bit/prompts/document_structured.txt"
    if digest(prompt_path) != PROMPT_SHA256:
        raise ValueError("Official document_structured prompt changed")
    return root / model_name, prompt_path.read_text(encoding="utf-8"), receipt


def require_offline() -> None:
    library = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    check = library.sandbox_check
    check.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int)
    check.restype = ctypes.c_int
    for operation in (b"network-outbound", b"network-inbound"):
        if check(os.getpid(), ctypes.c_char_p(operation), 0) != 1:
            raise RuntimeError("Network sandbox is not active; inference refused")


def current_rss() -> int:
    # proc_taskinfo layout from the macOS SDK: 6 uint64 followed by 12 int32.
    class TaskInfo(ctypes.Structure):
        _fields_ = [("values", ctypes.c_uint64 * 6), ("counters", ctypes.c_int32 * 12)]

    info = TaskInfo()
    library = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    function = library.proc_pidinfo
    function.argtypes = (ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int)
    function.restype = ctypes.c_int
    size = function(os.getpid(), 4, 0, ctypes.byref(info), ctypes.sizeof(info))
    if size != ctypes.sizeof(info):
        raise OSError(ctypes.get_errno(), "Cannot sample process RSS")
    return int(info.values[1])


class RssSampler:
    def __init__(self) -> None:
        self.start = current_rss()
        self.peak = self.start
        self.error = None
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.sample, daemon=True)

    def sample(self) -> None:
        try:
            while not self.stop.wait(0.05):
                self.peak = max(self.peak, current_rss())
        except OSError as error:
            self.error = error

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_args):
        self.stop.set()
        self.thread.join()

    def report(self) -> dict:
        if self.error:
            raise self.error
        end = current_rss()
        return {"rssStartBytes": self.start, "rssEndBytes": end,
                "rssSampledPeakBytes": max(self.peak, end), "rssSamplingIntervalMs": 50,
                "processLifetimePeakRssBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}


def parse_document(args: argparse.Namespace, verified_installation: tuple[Path, str, dict] | None = None,
                   verification_seconds: float | None = None) -> int:
    require_offline()
    pages = read_pages(args.pages)
    if verified_installation is None:
        start = time.perf_counter()
        verified_installation = verify_installation(args.installation)
        verification_seconds = time.perf_counter() - start
    model_path, task_prompt, receipt = verified_installation
    args.output.mkdir(mode=0o700)
    report = {"schemaVersion": 1, "status": "running", "variant": "8bit",
              "createdAt": datetime.now(timezone.utc).isoformat(), "network": "denied-by-seatbelt",
              "revision": REVISION, "receiptSha256": digest(args.installation / "receipt.json"),
              "evaluatorSha256": digest(Path(__file__)), "pagesManifestSha256": digest(args.pages),
              "promptSha256": PROMPT_SHA256, "dependencies": receipt["dependencies"],
              "installationVerificationSeconds": verification_seconds,
              "settings": {"temperature": 0.0, "maxTokens": MAX_TOKENS, "enableThinking": False,
                           "minPixels": MIN_PIXELS, "maxPixels": MAX_PIXELS, "seed": 0,
                           "repetitionPenalty": 1.03, "repetitionContextSize": 20}, "pages": []}
    try:
        with tempfile.TemporaryDirectory(prefix=".cache-", dir=args.output) as cache:
            os.environ.update(HF_HOME=cache, XDG_CACHE_HOME=cache, HF_HUB_OFFLINE="1",
                              TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1",
                              TOKENIZERS_PARALLELISM="false")
            import mlx.core as mx
            from mlx_vlm import load
            from mlx_vlm.generate import stream_generate
            from mlx_vlm.prompt_utils import apply_chat_template
            from PIL import Image

            mx.random.seed(0)
            start = time.perf_counter()
            model, processor = load(str(model_path), strict=True, lazy=False, trust_remote_code=False,
                                    local_files_only=True)
            mx.synchronize()
            report["loadSeconds"] = time.perf_counter() - start
            generation = strict_json((args.installation / "model-8bit/generation_config.json").read_text(encoding="utf-8"))
            eos_ids = generation["eos_token_id"]
            if eos_ids != [248044, 248046]:
                raise ValueError("Official EOS ids changed")
            tokenizer = processor.tokenizer
            tokenizer.stopping_criteria.eos_token_ids = eos_ids.copy()
            formatted = apply_chat_template(processor, model.config, task_prompt, num_images=1,
                                            enable_thinking=False, add_generation_prompt=True)
            (args.output / "prompt.txt").write_text(task_prompt, encoding="utf-8")
            (args.output / "formatted-prompt.txt").write_text(formatted, encoding="utf-8")
            report["formattedPromptSha256"] = digest(args.output / "formatted-prompt.txt")
            report["eosTokenIds"] = eos_ids
            for page in pages:
                if digest(Path(page["image"])) != page["sha256"]:
                    raise ValueError(f"Input changed during run: {page['id']}")
                with Image.open(page["image"]) as image:
                    width, height = image.size
                mx.synchronize()
                mx.clear_cache()
                mx.reset_peak_memory()
                mx.random.seed(0)
                raw_path = args.output / f"{page['id']}.raw.txt"
                last = None
                start = time.perf_counter()
                with RssSampler() as rss, raw_path.open("x", encoding="utf-8") as output:
                    for result in stream_generate(model, processor, formatted, image=[page["image"]],
                                                  temperature=0.0, max_tokens=MAX_TOKENS,
                                                  enable_thinking=False, min_pixels=MIN_PIXELS,
                                                  max_pixels=MAX_PIXELS, skip_special_tokens=False,
                                                  repetition_penalty=1.03, repetition_context_size=20):
                        output.write(result.text)
                        output.flush()
                        last = result
                    mx.synchronize()
                elapsed = time.perf_counter() - start
                if not report["pages"]:
                    report["firstInferenceSeconds"] = elapsed
                if last is None:
                    raise ValueError("Generator returned no token evidence")
                tokens = last.token_ids
                stop = termination(last.finish_reason, tokens, last.generation_tokens, eos_ids)
                blocks, errors = validate_document(raw_path.read_text(encoding="utf-8"))
                errors.extend(stop["errors"])
                page_report = {**page, "width": width, "height": height, "seconds": elapsed,
                               "peakMlxMemoryBytes": mx.get_peak_memory(), **rss.report(),
                               "promptTokens": last.prompt_tokens, "generationTokens": last.generation_tokens,
                               "termination": stop, "valid": not errors, "errors": errors,
                               "rawSha256": digest(raw_path), "blockCount": len(blocks) if blocks is not None else None}
                if blocks is not None:
                    write_json(args.output / f"{page['id']}.parsed.json", blocks)
                write_json(args.output / f"{page['id']}.tokens.json", tokens)
                write_json(args.output / f"{page['id']}.metrics.json", page_report)
                report["pages"].append(page_report)
                print(json.dumps({"page": page["id"], "seconds": elapsed, "valid": not errors}, ensure_ascii=False), flush=True)
            report["status"] = "completed" if all(page["valid"] for page in report["pages"]) else "invalid-output"
    except BaseException as error:
        report["status"] = "cancelled" if isinstance(error, KeyboardInterrupt) else "failed"
        report["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        write_json(args.output / "report.json", report)
    return 0 if report["status"] == "completed" else 2


def main(*, verified_root: Path | None = None,
         verified_installation: tuple[Path, str, dict] | None = None,
         verification_seconds: float | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--installation", type=Path, required=True)
    parser.add_argument("--pages", type=Path, required=True, help="JSON manifest of local page images and SHA256 hashes")
    parser.add_argument("--output", type=Path, required=True, help="New directory under an existing parent")
    parser.add_argument("--offline-worker", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        parser.error("Apple Silicon macOS is required")
    for name in ("installation", "pages", "output"):
        if not getattr(args, name).is_absolute():
            parser.error(f"--{name} must be absolute")
    if args.output.exists() or args.output.is_symlink() or not args.output.parent.is_dir():
        parser.error("--output must be new and its parent must exist")
    if verified_installation is not None and (verified_root is None or verified_root.resolve() != args.installation.resolve()):
        parser.error("Verified installation belongs to a different root")
    if not args.offline_worker:
        env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8",
               "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "DO_NOT_TRACK": "1"}
        os.execve("/usr/bin/sandbox-exec", ["sandbox-exec", "-p", OFFLINE_PROFILE,
                  sys.executable, "-I", "-B", str(Path(__file__).resolve()), *sys.argv[1:], "--offline-worker"], env)
    signal.signal(signal.SIGTERM, lambda *_: signal.raise_signal(signal.SIGINT))
    try:
        return parse_document(args, verified_installation, verification_seconds)
    except KeyboardInterrupt:
        print("Parsing cancelled; partial raw output and report retained", file=sys.stderr)
        return 130
    except Exception as error:
        print(f"Parsing failed: {error}", file=sys.stderr)
        return 1


def main_with_verified_installation(root: Path, installation: tuple[Path, str, dict], seconds: float) -> int:
    """Same-process handoff from the trusted bootstrap; never accepted from argv or environment."""
    return main(verified_root=root, verified_installation=installation, verification_seconds=seconds)


if __name__ == "__main__":
    raise SystemExit(main())
