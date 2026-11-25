#!/usr/bin/env python3
"""Exercise pinned cached metrics under the caller's OS network-deny sandbox."""
import argparse
import json
from pathlib import Path

from runtime import configure

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--runtime", type=Path, required=True)
args = parser.parse_args()
configure(args.runtime, offline=True)
import evaluate

results = {}
for name in ["bleu", "meteor"]:
    metric = evaluate.load(name)
    results[name] = metric.compute(predictions=["the cat sits on the mat"], references=[["the cat sits on the mat"]])
assert results["bleu"]["bleu"] == 1
assert abs(results["meteor"]["meteor"] - 0.9976851851851852) < 1e-12
print(json.dumps(results, indent=2))
