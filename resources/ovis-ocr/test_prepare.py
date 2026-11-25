"""Offline checks for download integrity, publication, cleanup and quantization."""

import hashlib
import importlib.util
import io
import json
import os
import struct
import tarfile
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


prepare = load("prepare_ovis", ROOT / "scripts/research/prepare-ovis-ocr.py")
convert = load("convert_ovis", ROOT / "resources/ovis-ocr/convert.py")


class PreparationTests(unittest.TestCase):
    def test_pinned_contract(self):
        manifest, packages, identities = prepare.load_spec()
        self.assertEqual(len(manifest["model"]["files"]), 29)
        self.assertEqual(len(packages), 67)
        self.assertEqual(packages["mlx-vlm"], "0.8.1")
        self.assertEqual(manifest["conversion"]["q_bits"], 8)
        self.assertFalse(manifest["conversion"]["trust_remote_code"])
        self.assertEqual(len(identities), 5)

    def test_reject_path_escape(self):
        for path in ("../escape", "/absolute", "a/../b", "a//b", "a\\b", ""):
            with self.subTest(path=path), self.assertRaises(ValueError):
                prepare.relative_path(path)

    def test_reject_unpinned_and_unhashed_dependencies(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "requirements.lock"
            for content in ("package>=1", "package==1", "--index-url https://example.com", "-e ."):
                path.write_text(content, encoding="utf-8")
                with self.subTest(content=content), self.assertRaises(ValueError):
                    prepare.locked_packages(path)

    def test_download_checks_size_and_hash(self):
        content = b"verified source"
        with tempfile.TemporaryDirectory() as directory:
            for index, expected in enumerate((
                {"size": len(content) - 1, "sha256": hashlib.sha256(content).hexdigest()},
                {"size": len(content), "sha256": "0" * 64},
            )):
                with patch.object(prepare.urllib.request, "urlopen", return_value=io.BytesIO(content)):
                    with self.assertRaises(ValueError):
                        prepare.download("https://example.com/source", Path(directory) / str(index), expected)
            path = Path(directory) / "valid"
            with patch.object(prepare.urllib.request, "urlopen", return_value=io.BytesIO(content)):
                prepare.download("https://example.com/source", path,
                                 {"size": len(content), "sha256": hashlib.sha256(content).hexdigest()})
            self.assertEqual(path.read_bytes(), content)

    def test_uv_archive_cannot_extract_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "uv.tar.gz"
            with tarfile.open(archive, "w:gz") as stream:
                member = tarfile.TarInfo("uv/uv")
                member.type = tarfile.SYMTYPE
                member.linkname = "/etc/passwd"
                stream.addfile(member)
            with self.assertRaises(ValueError):
                prepare.extract_uv(archive, Path(directory) / "uv", {"member": "uv/uv", "binarySize": 0})
            self.assertFalse((Path(directory) / "uv").exists())

    def test_failure_cleans_owned_stage_preserves_existing_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "existing"
            root.mkdir()
            sentinel = root / "user-data"
            sentinel.write_text("keep", encoding="utf-8")
            with self.assertRaises(RuntimeError):
                with prepare.owned_stage(root) as stage:
                    (stage / "partial").write_bytes(b"partial download")
                    raise RuntimeError("conversion failed")
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep")
            self.assertEqual(list(Path(directory).iterdir()), [root])

    def test_concurrent_lock_is_not_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "new"
            lock = Path(directory) / ".new.preparing"
            lock.mkdir()
            (lock / "owner").write_text("other", encoding="utf-8")
            with self.assertRaises(FileExistsError):
                with prepare.owned_stage(root):
                    self.fail("Must not acquire another preparation's lock")
            self.assertEqual((lock / "owner").read_text(encoding="utf-8"), "other")

    @unittest.skipUnless(os.uname().sysname == "Darwin", "Darwin exclusive rename")
    def test_publish_cannot_overwrite_even_empty_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "existing"
            stage = Path(directory) / "stage"
            root.mkdir()
            stage.mkdir()
            (stage / "candidate").write_text("new", encoding="utf-8")
            with self.assertRaises(FileExistsError):
                prepare.publish(stage, root)
            self.assertEqual(list(root.iterdir()), [])
            target = Path(directory) / "new"
            prepare.publish(stage, target)
            self.assertEqual((target / "candidate").read_text(encoding="utf-8"), "new")

    def test_receipt_detects_content_modification_and_added_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            python = Path(os.sys.executable).resolve()
            (root / "weight").write_bytes(b"original")
            receipt = {"schemaVersion": 1, "status": "converted-unvalidated", "specSha256": {},
                       "python": {}, "dependencies": {}, "files": prepare.inventory(root, python)}
            prepare.write_json(root / prepare.RECEIPT, receipt)
            prepare.verify_ready(root, python, {}, {}, {})
            (root / "weight").write_bytes(b"modified")
            with self.assertRaises(ValueError):
                prepare.verify_ready(root, python, {}, {}, {})
            (root / "weight").write_bytes(b"original")
            (root / "unexpected").write_bytes(b"new")
            with self.assertRaises(ValueError):
                prepare.verify_ready(root, python, {}, {}, {})

    def test_receipt_rejects_external_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "external").symlink_to("/etc/passwd")
            with self.assertRaises(ValueError):
                prepare.inventory(root, Path(os.sys.executable).resolve())

    def test_timeout_terminates_child_process(self):
        real_popen = prepare.subprocess.Popen
        processes = []

        def start(*args, **kwargs):
            process = real_popen(*args, **kwargs)
            processes.append(process)
            real_communicate = process.communicate
            process.communicate = lambda **_kwargs: real_communicate(timeout=0.05)
            return process

        before = time.monotonic()
        with patch.object(prepare.subprocess, "Popen", side_effect=start):
            with self.assertRaises(prepare.subprocess.TimeoutExpired):
                prepare.run([os.sys.executable, "-I", "-S", "-B", "-c",
                             "import time; time.sleep(60)"], {"PATH": "/usr/bin:/bin"})
        self.assertIsNotNone(processes[0].poll())
        self.assertLess(time.monotonic() - before, 10)

    def test_quantized_vision_or_missing_language_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "config.json").write_text(json.dumps({"model_type": "qwen3_5", "quantization": {
                "bits": 8, "group_size": 64, "mode": "affine"}}), encoding="utf-8")
            tensors = {
                "vision_tower.weight": {"dtype": "BF16", "shape": [1], "data_offsets": [0, 2]},
                "language_model.layer.scales": {"dtype": "BF16", "shape": [1], "data_offsets": [2, 4]},
                "language_model.layer.weight": {"dtype": "U32", "shape": [1], "data_offsets": [4, 8]},
            }

            def write_weights():
                header = json.dumps(tensors).encode()
                (root / "model.safetensors").write_bytes(struct.pack("<Q", len(header)) + header + b"\0" * 8)

            write_weights()
            report = convert.check_conversion(root)
            self.assertFalse(report["inferenceValidated"])
            self.assertEqual(report["quantizedLanguageModules"], 1)
            tensors["vision_tower.weight"]["dtype"] = "U32"
            write_weights()
            with self.assertRaises(ValueError):
                convert.check_conversion(root)
            tensors["vision_tower.weight"]["dtype"] = "BF16"
            del tensors["language_model.layer.scales"]
            write_weights()
            with self.assertRaises(ValueError):
                convert.check_conversion(root)


if __name__ == "__main__":
    unittest.main()
