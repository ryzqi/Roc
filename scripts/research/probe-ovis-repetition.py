"""Run a labelled 8-bit repetition-penalty probe without changing frozen inference.

Outputs are diagnostic evidence, never replacement pages or qualification.
The generated script is retained so its exact changed settings can be inspected.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def replace_once(source: str, old: str, new: str) -> str:
    if source.count(old) != 1:
        raise ValueError("Frozen inference shape changed")
    return source.replace(old, new, 1)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--installation", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--page", action="append", required=True)
    parser.add_argument("--penalty", type=float, required=True)
    args = parser.parse_args()
    if not 1 < args.penalty <= 1.2 or len(set(args.page)) != len(args.page):
        parser.error("Use a finite penalty in (1,1.2] and unique frozen page IDs")
    config_path = ROOT / "evaluation/ovis-evaluator/paired-inference.json"
    config = json.loads(config_path.read_text())
    installation, output = args.installation.resolve(), args.output.absolute()
    source_path = ROOT / config["inferenceScriptPath"]
    lock_path = ROOT / config["sourceLockPath"]
    pins = {source_path: config["inferenceScriptSha256"], lock_path: config["sourceLockSha256"],
            installation / "receipt.json": config["installationReceiptSha256"], config_path: digest(config_path)}
    for path, expected in pins.items():
        if digest(path) != expected:
            raise ValueError(f"Frozen input changed: {path}")
    source_root = ROOT / json.loads(lock_path.read_text())["localSourceRoot"]
    by_id = {p["id"]: p for p in config["pages"]}
    pages = []
    for id_ in args.page:
        page = by_id[id_]
        image = source_root / page["imagePath"]
        if digest(image) != page["sha256"]:
            raise ValueError(f"Frozen page changed: {id_}")
        pages.append({"id": id_, "image": str(image), "sha256": page["sha256"]})
    script = replace_once(source_path.read_text(),
        '"maxPixels": MAX_PIXELS, "seed": 0}',
        f'"maxPixels": MAX_PIXELS, "seed": 0, "repetitionPenalty": {args.penalty!r}, "repetitionContextSize": 20}}')
    script = replace_once(script,
        'max_pixels=MAX_PIXELS, skip_special_tokens=False)',
        f'max_pixels=MAX_PIXELS, skip_special_tokens=False, repetition_penalty={args.penalty!r}, repetition_context_size=20)')
    script = replace_once(script, '"network": "denied-by-seatbelt",',
        '"network": "denied-by-seatbelt", "scope": "diagnostic-repetition-probe", "automaticAdoption": False,')
    output.mkdir(parents=True)
    probe = output / "infer-probe.py"
    probe.write_text(script)
    manifest = output / "pages.json"
    manifest.write_text(json.dumps({"schemaVersion": 1, "pages": pages}, indent=2) + "\n")
    command = [str(installation / "runtime/bin/python"), "-I", "-B", str(probe),
               "--installation", str(installation), "--variant", "8bit", "--pages", str(manifest),
               "--output", str(output / "inference")]
    metadata = {"scope": __doc__, "status": "running", "automaticAdoption": False,
                "changedVariable": {"repetitionPenalty": args.penalty}, "repetitionContextSize": 20,
                "sourcePins": {str(p): h for p, h in pins.items()}, "probeSha256": digest(probe),
                "launcherSha256": digest(Path(__file__)), "pagesManifestSha256": digest(manifest), "command": command}
    (output / "started.json").write_text(json.dumps(metadata, indent=2) + "\n")
    child = None
    try:
        with (output / "inference.log").open("x") as log:
            child = subprocess.Popen(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            code = child.wait()
        metadata.update(status="finished", exitCode=code)
        if any(digest(p) != h for p, h in pins.items()):
            raise ValueError("Frozen inputs changed during diagnostic")
        report_path = output / "inference/report.json"
        report = json.loads(report_path.read_text())
        if (report["evaluatorSha256"] != metadata["probeSha256"]
                or report["settings"]["repetitionPenalty"] != args.penalty
                or [p["id"] for p in report["pages"]] != args.page):
            raise ValueError("Diagnostic output does not match requested settings/pages")
        metadata.update(inferenceReportSha256=digest(report_path), inferenceStatus=report["status"],
                        validPages=sum(p["valid"] for p in report["pages"]))
        return code
    except BaseException as error:
        metadata.update(status="failed", error=f"{type(error).__name__}: {error}")
        if child is not None and child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=30)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
        raise
    finally:
        (output / "diagnostic.json").write_text(json.dumps(metadata, indent=2) + "\n")
        print(json.dumps({k: metadata.get(k) for k in ("status", "inferenceStatus", "validPages", "error")}))


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: signal.raise_signal(signal.SIGINT))
    sys.exit(main())
