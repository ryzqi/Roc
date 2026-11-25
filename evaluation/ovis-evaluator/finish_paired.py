"""Wait for each frozen inference arm, score it offline, then compare v2 quality."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_status(output: Path, status: dict) -> None:
    temporary = output / "status.json.part"
    temporary.write_text(json.dumps(status, ensure_ascii=False, indent=2) + "\n")
    temporary.replace(output / "status.json")


def ready(inference: Path, arm: str, ids: list[str]) -> bool:
    status = json.loads((inference / "status.json").read_text())
    published = next((item for item in status.get("arms", []) if item.get("variant") == arm), None)
    report = inference / arm / "report.json"
    # The parent publishes status atomically after the writer exits. A report file
    # can be visible before its JSON has finished flushing; do not read it early.
    if published is not None:
        value = json.loads(report.read_text())
        if (value.get("status") not in ("completed", "invalid-output") or value.get("variant") != arm
                or [p["id"] for p in value.get("pages", [])] != ids):
            raise ValueError(f"Inference arm is incomplete or failed: {arm}")
        return True
    if status["status"] not in ("running", "predictions-collected", "predictions-collected-with-model-failures"):
        raise ValueError(f"Paired inference stopped: {status['status']}")
    if status["status"] != "running":
        raise ValueError(f"Completed paired run omitted required arm: {arm}")
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("runtime", "runtime-receipt", "inference", "baseline", "output"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    args = parser.parse_args()
    for name in ("runtime", "runtime_receipt", "inference", "baseline", "output"):
        setattr(args, name, getattr(args, name).absolute())
    repo = Path(__file__).resolve().parents[2]
    source = Path(__file__).resolve().parent
    config = json.loads((source / "paired-inference.json").read_text())
    ids = [page["id"] for page in config["pages"]]
    if len(ids) != 347 or len(set(ids)) != 347:
        raise ValueError("Unexpected frozen cohort")
    pins = {str(path): digest(path) for path in [*source.glob("*.py"), *source.glob("*.json"),
        args.runtime_receipt, args.baseline / "denominator-audit.json"]}
    args.output.mkdir()
    status = {"schemaVersion": 1, "status": "waiting", "sourcePins": pins, "arms": [],
              "automaticAdoption": False, "performanceQualification": False, "startedAtUnix": time.time()}
    write_status(args.output, status)
    child = None

    def check_pins() -> None:
        for name, expected in pins.items():
            if digest(Path(name)) != expected:
                raise ValueError(f"Scoring source/configuration changed while waiting: {name}")

    def run(command: list[str], name: str) -> None:
        nonlocal child
        check_pins()
        with (args.output / f"{name}.log").open("x") as log:
            child = subprocess.Popen(command, cwd=repo, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            code = child.wait()
            child = None
        if code:
            raise RuntimeError(f"{name} exited with code {code}")

    try:
        python = str(args.runtime / "venv/bin/python")
        for arm in config["orderedArms"]:
            status.update(status="waiting", activeArm=arm)
            write_status(args.output, status)
            while not ready(args.inference, arm, ids):
                if time.time() - status["startedAtUnix"] > 12 * 3600:
                    raise TimeoutError("Inference wait exceeded12hours; outputs retained")
                time.sleep(10)
            status["status"] = "scoring"
            write_status(args.output, status)
            output = args.output / arm
            run(["/usr/bin/sandbox-exec", "-p", "(version 1)(allow default)(deny network*)",
                 python, "-B", str(source / "score_arm.py"), "--runtime", str(args.runtime),
                 "--runtime-receipt", str(args.runtime_receipt), "--arm", arm,
                 "--inference", str(args.inference / arm), "--baseline", str(args.baseline), "--output", str(output)], arm)
            result = json.loads((output / "report.json").read_text())
            if result["status"] != "scored" or result["pages"] != 347:
                raise ValueError(f"Invalid scorer/gold result: {arm}")
            status["arms"].append({"arm": arm, "reportSha256": digest(output / "report.json"),
                                   "invalidPages": result["invalidPages"]})
            write_status(args.output, status)
        status["status"] = "comparing"
        write_status(args.output, status)
        comparison = args.output / "quantization-v2.json"
        run([python, "-B", str(source / "compare_v2.py"), "--scope", "quantization",
             "--reference", str(args.output / "original-bf16/report.json"),
             "--candidate", str(args.output / "8bit/report.json"), "--output", str(comparison)], "compare")
        passed = json.loads(comparison.read_text())["passed"]
        status.update(status="quality-passed" if passed else "quality-failed", comparisonSha256=digest(comparison))
        return 0 if passed else 2
    except BaseException as error:
        status.update(status="cancelled" if isinstance(error, KeyboardInterrupt) else "failed",
                      error=f"{type(error).__name__}: {error}")
        if child is not None:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=30)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
        return 130 if isinstance(error, KeyboardInterrupt) else 1
    finally:
        status["updatedAtUnix"] = time.time()
        write_status(args.output, status)
        print(json.dumps({key: value for key, value in status.items() if key != "sourcePins"}), flush=True)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: signal.raise_signal(signal.SIGINT))
    sys.exit(main())
