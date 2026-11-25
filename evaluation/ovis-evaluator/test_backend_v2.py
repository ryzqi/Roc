import json
from pathlib import Path
import tempfile
import unittest

from runtime import sha256
from score_arm import CONFIG_PATH
from score_backend_v2 import read_blocks, subset_baseline


class BackendV2Tests(unittest.TestCase):
    def test_subset_uses_original_gold_ids_without_reindexing(self):
        identity = lambda image, index: json.dumps({"img_id": image, "gt_idx": index, "gt_position": 4})
        selected, other = identity("chosen.jpg", 9), identity("other.jpg", 1)
        baseline = {"validEvaluatorGold": True, "configurationSha256": sha256(CONFIG_PATH),
                    "identities": {m: {selected: 1, other: 1} for m in ("text_block", "display_formula", "table")}}
        subset = subset_baseline(baseline, {"chosen.jpg"})
        self.assertEqual(subset["identities"]["table"], {selected: 1})
        with self.assertRaises(ValueError):
            subset_baseline(baseline, {"missing.jpg"})

    def test_raw_drift_invalidates_run_but_model_truncation_is_empty_prediction(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            raw = root / "one.raw.txt"
            raw.write_text('[{"bbox":[1,2,3,4],"category":"text","content":"x"}]')
            page = {"id": "one", "input": {"sha256": "image"}}
            metric = {"imageSha256": "image", "rawSha256": sha256(raw), "completed": True,
                      "eosObserved": True, "truncated": False, "lastTokenId": 248046}
            blocks, errors = read_blocks(root, page, metric, True, {"text"})
            self.assertEqual(len(blocks), 1)
            self.assertEqual(errors, [])
            metric["truncated"] = True
            blocks, errors = read_blocks(root, page, metric, True, {"text"})
            self.assertEqual(blocks, [])
            self.assertTrue(errors)
            raw.write_text('[]')
            with self.assertRaises(ValueError):
                read_blocks(root, page, metric, True, {"text"})


if __name__ == "__main__":
    unittest.main()
