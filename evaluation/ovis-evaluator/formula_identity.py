"""Prediction-independent gold identity across upstream formula matcher index spaces."""
from __future__ import annotations

from collections import Counter
import hashlib
import json


def formula_gold_identities(rows: list[dict]) -> Counter:
    result = Counter()
    for row in rows:
        # Upstream splits gold arrays before matching. Every resulting formula
        # has one position and exact gold string, even when gt_idx is renumbered
        # by a formula-only fallback. Counts retain identical repeated formulas.
        indices, positions = row.get("gt_idx"), row.get("gt_position")
        if (not isinstance(indices, list) or len(indices) != 1 or type(indices[0]) is not int
                or indices[0] < 0 or not isinstance(positions, list) or len(positions) != 1
                or not isinstance(row.get("gt"), str) or not row["gt"]
                or not isinstance(row.get("img_id"), str) or not row["img_id"]
                or row.get("gt_category_type") != "equation_isolated"):
            raise ValueError("Malformed singleton official formula gold identity")
        identity = {"img_id": row["img_id"], "gt_position": positions[0],
                    "gt_category_type": row["gt_category_type"],
                    "exactGoldSha256": hashlib.sha256(row["gt"].encode("utf-8")).hexdigest()}
        result[json.dumps(identity, sort_keys=True, ensure_ascii=False, separators=(",", ":"))] += 1
    return result
