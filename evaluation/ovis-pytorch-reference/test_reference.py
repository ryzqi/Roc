"""Regression checks for evidence-preserving strict comparison."""
import unittest

from compare import compare_blocks, require_acceptance_reference, strict_document


class ComparisonTests(unittest.TestCase):
    def setUp(self):
        self.block = {"bbox": [1, 2, 300, 400], "category": "table", "content": "<table><tr><td>A</td></tr></table>"}

    def test_one_coordinate_unit_allowed_but_two_rejected(self):
        self.assertTrue(compare_blocks([self.block], [{**self.block, "bbox": [2, 3, 301, 401]}], 1)["passed"])
        self.assertFalse(compare_blocks([self.block], [{**self.block, "bbox": [3, 2, 300, 400]}], 1)["passed"])

    def test_html_whitespace_and_order_are_not_normalized(self):
        other = {**self.block, "content": self.block["content"] + "\n"}
        self.assertFalse(compare_blocks([self.block], [other], 1)["passed"])
        self.assertFalse(compare_blocks([self.block, other], [other, self.block], 1)["passed"])

    def test_missing_blocks_fail(self):
        self.assertFalse(compare_blocks([self.block], [], 1)["passed"])

    def test_diagnostic_cannot_become_acceptance_reference(self):
        for report in ({"diagnostic": {}}, {"adoptionEligible": False}):
            with self.subTest(report=report), self.assertRaises(ValueError):
                require_acceptance_reference(report)

    def test_duplicate_keys_nonfinite_and_fenced_json_fail(self):
        for raw in ('[{"bbox":[],"bbox":[]}]', '[NaN]', '```json\n[]\n```'):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                strict_document(raw)


if __name__ == "__main__":
    unittest.main()
