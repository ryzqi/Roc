# /// script
# requires-python = ">=3.12"
# dependencies = ["pyarrow==26.0.1"]
# ///
"""Small export-integrity fixtures; these are not scientific ground truth."""
import importlib.util
import json
import tempfile
import tomllib
import unittest
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("m3_export", ROOT / "scripts/prepare-scientific-m3sciqa.py")
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


class DependencyTests(unittest.TestCase):
    def test_exporter_and_tests_use_the_same_pyarrow_release_and_hashes(self):
        def pyarrow_lock(script):
            with Path(script).with_suffix(".py.lock").open("rb") as stream:
                packages = tomllib.load(stream)["package"]
            return next(package for package in packages if package["name"] == "pyarrow")

        locked = pyarrow_lock(exporter.__file__)
        self.assertEqual(pyarrow_lock(__file__), locked)
        self.assertEqual(pa.__version__, locked["version"])


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="roc-m3-export-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.output = self.root / "output"
        (self.source / "m3sciqa").mkdir(parents=True)
        self.row = {key: f"原始 {key}  " for key in exporter.TEXT_COLUMNS}
        self.row.update(modal="table", evidence_reference="", figure={
            "bytes": b"\x89PNG\r\n\x1a\nfixture-bytes", "path": "original/figure.png",
        })
        parquet = self.source / "m3sciqa/validation.parquet"
        pq.write_table(pa.Table.from_pylist([self.row]), parquet)
        data = parquet.read_bytes()
        self.lock = self.root / "lock.json"
        self.lock.write_text(json.dumps({"sources": [{
            "id": "m3sciqa", "revision": "fixture-revision", "split": "validation",
            "expectedRows": 1, "license": "fixture", "annotationProvenance": "fixture",
            "files": [{"path": "m3sciqa/validation.parquet", "bytes": len(data),
                       "sha256": exporter.digest(data)}],
        }]}))
        original_lock = exporter.LOCK
        exporter.LOCK = self.lock
        self.addCleanup(setattr, exporter, "LOCK", original_lock)

    def test_original_labels_and_images_are_preserved_and_rebuilt(self):
        report = exporter.prepare(self.source, self.output)
        labels = json.loads((self.output / "labels.json").read_bytes())
        self.assertEqual(labels[0]["original"], {key: self.row[key] for key in exporter.TEXT_COLUMNS})
        self.assertEqual(labels[0]["evidenceStatus"], "missing-published-reference-evidence")
        self.assertEqual((self.output / labels[0]["figure"]["path"]).read_bytes(), self.row["figure"]["bytes"])
        self.assertEqual(exporter.prepare(self.source, self.output, verify=True), report)
        self.assertFalse(report["scientificBaselineReady"])

    def test_label_corruption_cannot_be_repaired_by_verify_or_prepare(self):
        exporter.prepare(self.source, self.output)
        path = self.output / "labels.json"
        path.write_bytes(b"[]\n")
        for verify in (True, False):
            with self.assertRaisesRegex(ValueError, "export_changed:labels.json"):
                exporter.prepare(self.source, self.output, verify=verify)
        self.assertEqual(path.read_bytes(), b"[]\n")

    def test_changed_original_parquet_is_rejected_before_export(self):
        path = self.source / "m3sciqa/validation.parquet"
        data = bytearray(path.read_bytes())
        data[10] ^= 1
        path.write_bytes(data)
        with self.assertRaisesRegex(ValueError, "source_changed"):
            exporter.prepare(self.source, self.output)
        self.assertFalse(self.output.exists())

    def test_missing_or_changed_image_fails_reconstruction(self):
        exporter.prepare(self.source, self.output)
        image = next((self.output / "images").iterdir())
        image.write_bytes(b"altered")
        with self.assertRaisesRegex(ValueError, "export_changed:images/"):
            exporter.prepare(self.source, self.output, verify=True)
        image.unlink()
        with self.assertRaisesRegex(ValueError, "export_changed:images/"):
            exporter.prepare(self.source, self.output, verify=True)

    def test_source_and_output_symlinks_and_parent_escape_are_rejected(self):
        for name in ("../escape", "/tmp/escape"):
            with self.assertRaisesRegex(ValueError, "path_invalid"):
                exporter.bounded_path(self.source, name)
        self.output.symlink_to(self.source, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "path_invalid"):
            exporter.prepare(self.source, self.output)
        parquet = self.source / "m3sciqa/validation.parquet"
        original = self.root / "original.parquet"
        parquet.rename(original)
        parquet.symlink_to(original)
        with self.assertRaisesRegex(ValueError, "path_invalid"):
            exporter.prepare(self.source, self.root / "other")


if __name__ == "__main__":
    unittest.main()
