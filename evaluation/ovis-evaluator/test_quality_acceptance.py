import copy
import json
from pathlib import Path
import unittest

from quality_acceptance import aggregate_source, compare_quality, source_metrics

ROOT = Path(__file__).parent
SCORING = json.loads((ROOT / "scoring.json").read_text())
CONTRACT = json.loads((ROOT / "acceptance-v2.json").read_text())


def fixture():
    return {"page_info": {"width": 1000, "height": 1000}, "layout_dets": [
        {"category_type": "text_block", "poly": [100, 100, 400, 100, 400, 200, 100, 200], "order": 1},
        {"category_type": "table", "poly": [100, 300, 400, 300, 400, 400, 100, 400], "order": 2}]}, [
        {"category": "text", "content": "text", "bbox": [100, 100, 400, 200]},
        {"category": "table", "content": "table", "bbox": [100, 300, 400, 400]}]


def report(page, blocks):
    return {"status": "scored", "text": {"cer": 0.1}, "officialCDM": 0.9, "officialTEDS": 0.9,
            "invalidPages": 0, "pages": 1, "source": aggregate_source([source_metrics(page, blocks, SCORING)])}


class QualityAcceptanceTests(unittest.TestCase):
    def test_identical_including_table_order_passes(self):
        page, blocks = fixture()
        r = report(page, blocks)
        self.assertEqual(r["source"]["order"]["pairs"], 1)
        self.assertTrue(compare_quality(r, r, CONTRACT)["passed"])

    def test_reverse_order_fails_even_with_perfect_content_and_geometry(self):
        page, blocks = fixture()
        result = compare_quality(report(page, blocks), report(page, blocks[::-1]), CONTRACT)
        self.assertFalse(result["passed"])
        self.assertTrue(any(x["name"] == "reading order inversion delta" and not x["passed"] for x in result["checks"]))

    def test_deleting_table_cannot_shrink_denominator(self):
        page, blocks = fixture()
        before, after = report(page, blocks), report(page, blocks[:1])
        self.assertEqual(after["source"]["families"]["table"]["gold"], 1)
        self.assertEqual(after["source"]["families"]["table"]["recall"], 0)
        self.assertFalse(compare_quality(before, after, CONTRACT)["passed"])

    def test_extra_prediction_and_shift_are_not_repaired(self):
        page, blocks = fixture()
        extra = blocks + [{"category": "image", "content": "", "bbox": [600, 600, 800, 800]}]
        self.assertFalse(compare_quality(report(page, blocks), report(page, extra), CONTRACT)["passed"])
        shifted = copy.deepcopy(blocks)
        shifted[0]["bbox"] = [120, 100, 420, 200]
        self.assertFalse(compare_quality(report(page, blocks), report(page, shifted), CONTRACT)["passed"])

    def test_no_gold_order_never_becomes_zero_error_pass(self):
        page, blocks = fixture()
        for block in page["layout_dets"]:
            block.pop("order")
        r = report(page, blocks)
        self.assertIsNone(r["source"]["order"]["inversionRate"])
        self.assertFalse(compare_quality(r, r, CONTRACT)["passed"])

    def test_margins_and_evaluator_errors_fail_closed(self):
        page, blocks = fixture()
        a = report(page, blocks)
        for key, value in (("officialCDM", 0.88), ("officialTEDS", None), ("status", "invalid-evaluator"), ("invalidPages", 1)):
            b = copy.deepcopy(a)
            b[key] = value
            self.assertFalse(compare_quality(a, b, CONTRACT)["passed"])


if __name__ == "__main__":
    unittest.main()
