"""Test evaluation output boundaries without importing MLX or running inference."""

import importlib.util
import json
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("ovis_infer", Path(__file__).with_name("infer.py"))
infer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(infer)


class OutputBoundaryTests(unittest.TestCase):
    def block(self, **changes):
        return {"bbox": [0, 0, 999, 999], "category": "text", "content": "原始内容", **changes}

    def assert_invalid(self, value):
        _blocks, errors = infer.validate_document(json.dumps(value))
        self.assertTrue(errors)

    def test_valid_output_preserves_text_and_order(self):
        blocks = [self.block(content="  text\n\\alpha  "), self.block(category="table", content="<table></table>")]
        parsed, errors = infer.validate_document(json.dumps(blocks))
        self.assertEqual(parsed, blocks)
        self.assertEqual(errors, [])

    def test_json_fences_or_extra_text_are_not_repaired(self):
        for raw in ("```json\n[]\n```", "Here is the result: []", "[] trailing", "[", ""):
            with self.subTest(raw=raw):
                parsed, errors = infer.validate_document(raw)
                self.assertIsNone(parsed)
                self.assertTrue(errors)

    def test_duplicate_fields_are_rejected(self):
        _parsed, errors = infer.validate_document('[{"bbox":[0,0,1,1],"category":"text","content":"a","content":"b"}]')
        self.assertIn("Duplicate JSON key", errors[0])

    def test_nan_and_infinity_are_not_json(self):
        for token in ("NaN", "Infinity", "-Infinity"):
            with self.subTest(token=token):
                _parsed, errors = infer.validate_document(f'[{token}]')
                self.assertTrue(errors)

    def test_top_level_and_block_schema_are_exact(self):
        for value in ({"blocks": []}, [None], [self.block(extra=1)], [{"bbox": [0, 0, 1, 1]}]):
            with self.subTest(value=value):
                self.assert_invalid(value)

    def test_bbox_integers_exclude_booleans_and_floats(self):
        for bbox in ([False, 0, 1, 1], [0.0, 0, 1, 1], ["0", 0, 1, 1], [0, 0, 1], None):
            with self.subTest(bbox=bbox):
                self.assert_invalid([self.block(bbox=bbox)])

    def test_bbox_out_of_range_or_inverted_fails(self):
        for bbox in ([-1, 0, 1, 1], [0, 0, 1000, 1], [1, 0, 1, 1], [2, 0, 1, 1], [0, 2, 1, 1]):
            with self.subTest(bbox=bbox):
                self.assert_invalid([self.block(bbox=bbox)])

    def test_unknown_category_and_nonstring_content_fail(self):
        for block in (self.block(category="Text"), self.block(category=[]), self.block(content={})):
            with self.subTest(block=block):
                self.assert_invalid([block])

    def test_empty_page_is_structurally_valid_without_claiming_quality(self):
        self.assertEqual(infer.validate_document("[]"), ([], []))

    def test_official_eos_confirms_completion(self):
        result = infer.termination("stop", [1, 248046], 2, [248044, 248046])
        self.assertTrue(result["eosObserved"])
        self.assertFalse(result["truncated"])
        self.assertEqual(result["errors"], [])

    def test_length_is_failure_even_with_parseable_json(self):
        result = infer.termination("length", [7] * infer.MAX_TOKENS, infer.MAX_TOKENS, [248044, 248046])
        self.assertTrue(result["truncated"])
        self.assertIn("token_budget_exhausted", result["errors"])

    def test_stop_requires_eos_token_evidence(self):
        result = infer.termination("stop", [1, 2], 2, [248044, 248046])
        self.assertIn("stop_without_official_eos", result["errors"])

    def test_missing_finish_or_inconsistent_count_fails(self):
        result = infer.termination(None, [248046], 2, [248044, 248046])
        self.assertIn("finish_reason_missing_or_unknown", result["errors"])
        self.assertIn("token_evidence_invalid", result["errors"])

    def test_eos_at_last_allowed_token_is_completion(self):
        tokens = [7] * (infer.MAX_TOKENS - 1) + [248046]
        result = infer.termination("stop", tokens, infer.MAX_TOKENS, [248044, 248046])
        self.assertEqual(result["errors"], [])


if __name__ == "__main__":
    unittest.main()
