import unittest

from quality_metrics import match_text, normalize, iou


class CompleteDenominatorTests(unittest.TestCase):
    def test_extra_and_missing_are_insertions_and_deletions(self):
        gold = [{"index": 0, "normalized": "alpha"}]
        extra = [{"index": 0, "normalized": "alpha"}, {"index": 1, "normalized": "invented"}]
        rows = match_text(gold, extra)
        self.assertEqual(sum(r["characterEdits"] for r in rows), len("invented"))
        self.assertEqual(sum(r["goldCharacters"] for r in rows), len("alpha"))
        self.assertEqual(match_text(gold, [])[0]["characterEdits"], len("alpha"))

    def test_pairing_does_not_drop_different_lengths(self):
        g = [{"index": 0, "normalized": "abc"}, {"index": 1, "normalized": "long content"}]
        p = [{"index": 0, "normalized": "long contant"}, {"index": 1, "normalized": "abc"}]
        rows = match_text(g, p)
        self.assertEqual(sum(r["characterEdits"] for r in rows), 1)
        self.assertEqual(sum(r["goldCharacters"] for r in rows), 15)
        self.assertEqual(sum(r["wordEdits"] for r in rows), 1)

    def test_normalization_preserves_case_punctuation_and_formula(self):
        self.assertEqual(normalize(" A\tB,\n $x^2$ e\u0301 "), "A B, $x^2$ é")

    def test_iou_uses_unclipped_coordinates(self):
        self.assertEqual(iou([0, 0, 1, 1], [0, 0, 1, 1]), 1)
        self.assertAlmostEqual(iou([-1, 0, 1, 1], [0, 0, 1, 1]), 0.5)


if __name__ == "__main__":
    unittest.main()
