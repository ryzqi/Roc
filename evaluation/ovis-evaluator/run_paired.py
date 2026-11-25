#!/usr/bin/env python3
"""Collect both frozen MLX arms serially. A failed arm never becomes a quality pass."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
from datetime import datetime, timezone


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_status(path: Path, value: object) -> None:
    temporary = path.with_suffix(".part")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--installation", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    repo = Path(__file__).absolute().parents[2]
    config_path = Path(__file__).with_name("paired-inference.json").absolute()
    config_bytes = config_path.read_bytes()
    config = json.loads(config_bytes)
    relative = config_path.relative_to(repo).as_posix()
    committed = subprocess.run(["git", "show", f"HEAD:{relative}"], cwd=repo, check=True, capture_output=True).stdout
    if committed != config_bytes:
        raise ValueError("paired inference configuration must match the committed HEAD before execution")
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, check=True, capture_output=True, text=True).stdout.strip()
    for path_key, hash_key in [("sourceLockPath", "sourceLockSha256"), ("selectionPath", "selectionSha256"),
                               ("inferenceScriptPath", "inferenceScriptSha256")]:
        if sha256(repo / config[path_key]) != config[hash_key]:
            raise ValueError(f"frozen identity changed: {config[path_key]}")
    installation = args.installation.absolute()
    if sha256(installation / "receipt.json") != config["installationReceiptSha256"]:
        raise ValueError("model installation identity changed")
    lock = json.loads((repo / config["sourceLockPath"]).read_text(encoding="utf-8"))
    source_root = repo / lock["localSourceRoot"]
    pages = []
    for item in config["pages"]:
        image = source_root / item["imagePath"]
        if sha256(image) != item["sha256"]:
            raise ValueError(f"input changed: {item['id']}")
        pages.append({"id": item["id"], "image": str(image), "sha256": item["sha256"]})
    if len(pages) != 347 or len({p["id"] for p in pages}) != 347:
        raise ValueError("frozen cohort changed")
    output = args.output.absolute()
    output.mkdir(parents=True, exist_ok=False)
    manifest = output / "pages.json"
    manifest.write_text(json.dumps({"schemaVersion": 1, "pages": pages}, indent=2) + "\n", encoding="utf-8")
    (output / "frozen-config.json").write_bytes(config_bytes)
    status = {"schemaVersion": 1, "status": "running", "gitHead": head,
              "createdAt": datetime.now(timezone.utc).isoformat(),
              "configurationSha256": sha256(config_path), "runnerSha256": sha256(Path(__file__)),
              "pagesManifestSha256": sha256(manifest), "selectedPagesPerArm": 347,
              "automaticQualityAcceptanceAllowed": False, "arms": []}
    child = None

    def stop(_signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    try:
        for arm in config["orderedArms"]:
            status["activeArm"] = arm
            write_status(output / "status.json", status)
            argv = [str(installation / "runtime/bin/python"), "-I", "-B", str(repo / config["inferenceScriptPath"]),
                    "--installation", str(installation), "--variant", arm, "--pages", str(manifest),
                    "--output", str(output / arm)]
            with (output / f"{arm}.log").open("x", encoding="utf-8") as log:
                child = subprocess.Popen(argv, cwd=repo, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                code = child.wait()
                child = None
            report_path = output / arm / "report.json"
            report = json.loads(report_path.read_text(encoding="utf-8")) if report_path.exists() else {}
            if report.get("status") in ("completed", "invalid-output"):
                expected_settings = {k: config["settings"][k] for k in ("temperature", "maxTokens", "enableThinking", "minPixels", "maxPixels", "seed")}
                if report.get("settings") != expected_settings or report.get("formattedPromptSha256") != config["settings"]["formattedPromptSha256"]:
                    raise ValueError("actual inference settings differ from the committed contract")
            completed = {p["id"] for p in report.get("pages", [])}
            if report.get("status") in ("completed", "invalid-output") and [p["id"] for p in report.get("pages", [])] != [p["id"] for p in pages]:
                raise ValueError("completed report page IDs/order differ from the frozen manifest")
            status["arms"].append({"variant": arm, "exitCode": code, "status": report.get("status", "report-missing"),
                                   "completedPages": len(completed), "validPages": sum(p["valid"] for p in report.get("pages", [])),
                                   "unprocessedPageIds": [p["id"] for p in pages if p["id"] not in completed]})
            if code not in (0, 2) or len(completed) != len(pages):
                status["status"] = "incomplete-runtime-failure"
                return 1
        status["status"] = "predictions-collected" if all(a["exitCode"] == 0 for a in status["arms"]) else "predictions-collected-with-model-failures"
        return 0
    except KeyboardInterrupt:
        status["status"] = "cancelled"
        if child is not None:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=20)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
        return 130
    except Exception as error:
        status["status"] = "failed"
        status["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        status["updatedAt"] = datetime.now(timezone.utc).isoformat()
        write_status(output / "status.json", status)


if __name__ == "__main__":
    raise SystemExit(main())
