"""Regression checks for invalid metric runs and real PDF-to-pixel coordinates."""
import hashlib
from pathlib import Path
import tempfile
import unittest

import numpy as np
import pymupdf

from calibrate import classify_cdm
from verify_pdf_slices import DPI, checked, transforms


class MetricValidityTests(unittest.TestCase):
    def test_zero_gold_tokens_invalidate_even_a_perfect_score(self):
        self.assertEqual(classify_cdm({"gt_tokens": 0, "pred_tokens": 10, "F1_score": 1}), "invalid-evaluator-or-gold")

    def test_explicit_scorer_error_invalidates_nonzero_gold(self):
        self.assertEqual(classify_cdm({"gt_tokens": 8, "pred_tokens": 0, "F1_score": 0, "cdm_eval_error": "renderer failed"}), "invalid-evaluator-or-gold")

    def test_bad_candidate_with_renderable_gold_is_model_failure(self):
        self.assertEqual(classify_cdm({"gt_tokens": 8, "pred_tokens": 0, "F1_score": 0}), "model-failure")

    def test_valid_identical_formula(self):
        self.assertEqual(classify_cdm({"gt_tokens": 8, "pred_tokens": 8, "F1_score": 1}), "perfect")


class PdfGeometryTests(unittest.TestCase):
    def test_crop_rotation_and_dpi_predict_actual_rendered_marker(self):
        for rotation in [0, 90, 180, 270]:
            with self.subTest(rotation=rotation), pymupdf.open() as doc:
                page = doc.new_page(width=200.3, height=300.7)
                page.draw_rect(pymupdf.Rect(68, 98, 72, 102), color=(1, 0, 0), fill=(1, 0, 0))
                raw_pdf_center = pymupdf.Point(70, 100) * ~page.transformation_matrix
                page.set_cropbox(pymupdf.Rect(20.1, 30.2, 180.2, 250.3))
                page.set_rotation(rotation)
                pix = page.get_pixmap(dpi=DPI, colorspace=pymupdf.csRGB, alpha=False)
                matrix = transforms(page, (pix.width, pix.height), (pix.width, pix.height), (pix.x, pix.y))
                predicted = raw_pdf_center * pymupdf.Matrix(*matrix["pdfToRenderPixels"])
                image = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3)
                ys, xs = np.nonzero((image[:, :, 0] > 250) & (image[:, :, 1] < 20) & (image[:, :, 2] < 20))
                self.assertGreater(len(xs), 20)
                self.assertLess(abs(predicted.x - (xs.mean() + 0.5)), 1)
                self.assertLess(abs(predicted.y - (ys.mean() + 0.5)), 1)

    def test_corrupted_bytes_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            file = root / "input.pdf"
            file.write_bytes(b"original")
            record = {"path": file.name, "bytes": 8, "sha256": hashlib.sha256(b"original").hexdigest()}
            self.assertEqual(checked(root, record), file.resolve())
            file.write_bytes(b"modified")
            with self.assertRaisesRegex(ValueError, "identity changed"):
                checked(root, record)


if __name__ == "__main__":
    unittest.main()
