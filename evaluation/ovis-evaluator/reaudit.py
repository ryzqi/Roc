"""Re-audit saved official results without replacing their original source-bound report."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from score_arm import CONFIG_PATH, audit_official, sha256, write_json


def reaudit(source: Path, output: Path, baseline: Path | None = None) -> dict:
    started = json.loads((source / "started.json").read_text())
    original = json.loads((source / "report.json").read_text())
    if started["configurationSha256"] != sha256(CONFIG_PATH) or original["configurationSha256"] != sha256(CONFIG_PATH):
        raise ValueError("Saved results belong to a different scoring configuration")
    inputs = [source / name for name in ("started.json", "report.json", "gold.json", "official-config.json", "official.log")]
    inputs.extend(sorted((source / "result").rglob("*.json")))
    inputs.extend(sorted((source / "result").rglob("*.jsonl")))
    identity = {path.relative_to(source).as_posix(): sha256(path) for path in inputs}
    audit, metrics = audit_official(source, baseline)
    if any(sha256(source / name) != expected for name, expected in identity.items()):
        raise ValueError("Saved results changed while auditing")
    output.mkdir()
    write_json(output / "denominator-audit.json", audit)
    result = {"schemaVersion": 1, "scope": "read-only audit of saved official scoring results; no evaluator rerun",
              "status": "qualified-gold-denominator" if audit["validEvaluatorGold"] else "invalid-evaluator-or-denominator",
              "source": str(source.resolve()), "sourceFiles": identity,
              "recordedRunnerSha256AtStart": started["scriptSha256"],
              "recordedRunnerSha256AtEnd": original["scriptSha256"],
              "runnerFileChangedDuringRun": started["scriptSha256"] != original["scriptSha256"],
              "auditScriptSha256": sha256(Path(__file__)),
              "auditImplementationSha256": sha256(Path(__file__).with_name("score_arm.py")),
              "configurationSha256": sha256(CONFIG_PATH), "coverage": audit["coverage"],
              "officialCDM": metrics["display_formula"]["all"]["CDM"]["all"],
              "officialTEDS": metrics["table"]["all"]["TEDS"]["all"],
              "automaticAdoption": False}
    write_json(output / "report.json", result)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--baseline", type=Path)
    args = parser.parse_args()
    result = reaudit(args.source, args.output, args.baseline)
    print(json.dumps({"status": result["status"], "coverage": result["coverage"]}))


if __name__ == "__main__":
    main()
