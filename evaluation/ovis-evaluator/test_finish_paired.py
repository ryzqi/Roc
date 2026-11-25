import json
from pathlib import Path
import tempfile
import unittest

from finish_paired import ready


class PairedCompletionTests(unittest.TestCase):
    def test_only_complete_ordered_arms_are_ready_and_invalid_predictions_remain_scorable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "original-bf16").mkdir()
            (root / "status.json").write_text(json.dumps({"status": "running"}))
            self.assertFalse(ready(root, "original-bf16", ["a", "b"]))
            path = root / "original-bf16/report.json"
            path.write_text('{"status":')
            self.assertFalse(ready(root, "original-bf16", ["a", "b"]))
            (root / "status.json").write_text(json.dumps({"status": "running", "arms": [{"variant": "original-bf16"}]}))
            for status in ("completed", "invalid-output"):
                path.write_text(json.dumps({"status": status, "variant": "original-bf16", "pages": [{"id": "a"}, {"id": "b"}]}))
                self.assertTrue(ready(root, "original-bf16", ["a", "b"]))
                with self.assertRaises(ValueError):
                    ready(root, "original-bf16", ["b", "a"])
                with self.assertRaises(ValueError):
                    ready(root, "original-bf16", ["a", "b", "c"])

    def test_stopped_inference_is_not_an_indefinite_wait(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for status in ("cancelled", "failed", "incomplete-runtime-failure"):
                (root / "status.json").write_text(json.dumps({"status": status}))
                with self.assertRaises(ValueError):
                    ready(root, "8bit", ["a"])
