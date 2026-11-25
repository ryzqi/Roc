"""Ensure evaluator failures and denominator changes cannot become model scores."""
import json
from pathlib import Path
import tempfile
import unittest

from score_arm import audit_official, strict_blocks


class DenominatorAuditTests(unittest.TestCase):
    def fixture(self, root):
        result = root / "result"
        result.mkdir(parents=True)
        (root / "gold.json").write_text('[{}]', encoding="utf-8")
        for metric in ("text_block", "display_formula", "table"):
            row = {"img_id": "page.jpg", "gt_idx": [0], "gt_position": [1],
                   "gt_category_type": metric, "gt": "a", "img_id_cdm": "0"}
            (result / f"predictions_quick_match_{metric}_result.json").write_text(json.dumps([row]))
        box = result / "predictions_quick_match_display_formula/CDM/gt/bbox/0.jsonl"
        box.parent.mkdir(parents=True)
        box.write_text('{"bbox":[1,1,2,2],"token":"a"}\n')
        metrics = {"match_debug": {"page_count": 1, "text_match_fallback_counts": {}},
                   "display_formula": {"metric_debug": {}}, "table": {"metric_debug": {}}}
        path = result / "predictions_quick_match_metric_result.json"
        path.write_text(json.dumps(metrics))
        return box, path, metrics

    def test_missing_gold_row_invalidates_denominator(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            baseline, candidate = root / "baseline", root / "candidate"
            self.fixture(baseline)
            self.fixture(candidate)
            audit, _ = audit_official(baseline, None)
            self.assertTrue(audit["validEvaluatorGold"])
            (baseline / "denominator-audit.json").write_text(json.dumps(audit))
            (candidate / "result/predictions_quick_match_table_result.json").write_text('[]')
            audit, _ = audit_official(candidate, baseline)
            self.assertFalse(audit["validEvaluatorGold"])
            self.assertEqual(audit["errors"][0]["kind"], "gold-denominator-differs")

    def test_unrenderable_gold_and_match_timeout_are_invalid(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            box, path, metrics = self.fixture(root)
            box.write_text("")
            metrics["match_debug"]["text_match_fallback_counts"] = {"page_timeout": 1}
            path.write_text(json.dumps(metrics))
            audit, _ = audit_official(root, None)
            self.assertEqual({e["kind"] for e in audit["errors"]},
                             {"unrenderable-gold", "official-match-timeout-fallback"})

    def test_malformed_category_is_rejected_as_invalid_json_document(self):
        with self.assertRaises(ValueError):
            strict_blocks('[{"bbox":[1,2,3,4],"category":{},"content":"a"}]', {"text"})

    def test_extra_predictions_remain_visible_without_becoming_gold(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            baseline, candidate = root / "baseline", root / "candidate"
            self.fixture(baseline)
            self.fixture(candidate)
            audit, _ = audit_official(baseline, None)
            (baseline / "denominator-audit.json").write_text(json.dumps(audit))
            for metric in ("text_block", "display_formula", "table"):
                path = candidate / f"result/predictions_quick_match_{metric}_result.json"
                rows = json.loads(path.read_text())
                rows.append({"img_id": "page.jpg", "gt_idx": [""], "gt": "",
                             "pred_idx": [1], "pred": "extra", "img_id_cdm": "extra"})
                path.write_text(json.dumps(rows))
            observed, _ = audit_official(candidate, baseline)
            self.assertTrue(observed["validEvaluatorGold"], observed["errors"])
            self.assertEqual(observed["identities"], audit["identities"])
            for coverage in observed["coverage"].values():
                self.assertEqual(coverage["matchedRows"], 2)
                self.assertEqual(coverage["goldRows"], 1)
                self.assertEqual(coverage["extraPredictionRows"], 1)

    def test_merged_matches_preserve_each_gold_identity_and_detect_duplicates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            baseline, candidate = root / "baseline", root / "candidate"
            self.fixture(baseline)
            self.fixture(candidate)
            name = "result/predictions_quick_match_text_block_result.json"
            row = json.loads((baseline / name).read_text())[0]
            other = {**row, "gt_idx": [1], "gt_position": [2], "gt_category_type": "title"}
            (baseline / name).write_text(json.dumps([row, other]))
            audit, _ = audit_official(baseline, None)
            (baseline / "denominator-audit.json").write_text(json.dumps(audit))
            merged = {**row, "gt_idx": [0, 1], "gt_position": [1, 2]}
            (candidate / name).write_text(json.dumps([merged]))
            observed, _ = audit_official(candidate, baseline)
            self.assertTrue(observed["validEvaluatorGold"], observed["errors"])
            (candidate / name).write_text(json.dumps([merged, other]))
            observed, _ = audit_official(candidate, baseline)
            self.assertFalse(observed["validEvaluatorGold"])


if __name__ == "__main__":
    unittest.main()
