import hashlib
import importlib.util
import os
from email.message import Message
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
from prepare import portable_python
from collect_licenses import collect

spec = importlib.util.spec_from_file_location("research_models", SCRIPTS / "fetch-models.py")
models = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = models
spec.loader.exec_module(models)


class ModelTests(unittest.TestCase):
    def test_retains_huggingface_partial_download_across_failed_invocations(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = models.ModelSource("owner/model", "a" * 40, "model", "Apache-2.0",
                                        {"model.safetensors": hashlib.sha256(b"weights").hexdigest()})

            def interrupted(**kwargs):
                staging = kwargs["local_dir"]
                partial = staging / ".cache/huggingface/download/model.incomplete"
                partial.parent.mkdir(parents=True)
                partial.write_bytes(b"wei")
                raise ConnectionError("connection interrupted")

            with patch.object(models, "snapshot_download", interrupted), self.assertRaises(ConnectionError):
                models.fetch(source, root)
            self.assertFalse((root / "model").exists())

            def resumed(**kwargs):
                staging = kwargs["local_dir"]
                self.assertEqual((staging / ".cache/huggingface/download/model.incomplete").read_bytes(), b"wei")
                (staging / "model.safetensors").write_bytes(b"weights")

            with patch.object(models, "snapshot_download", resumed):
                models.fetch(source, root)
            self.assertEqual((root / "model/model.safetensors").read_bytes(), b"weights")
            self.assertFalse((root / "model/.cache").exists())
            models.verify_files(root / "model", source)

    def test_verifies_configuration_hash_as_well_as_weight_hash(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "model.safetensors").write_bytes(b"weights")
            (root / "config.json").write_bytes(b"config")
            source = models.ModelSource("owner/model", "a" * 40, "model", "Apache-2.0",
                                        {"model.safetensors": hashlib.sha256(b"weights").hexdigest(),
                                         "config.json": hashlib.sha256(b"config").hexdigest()})
            models.verify_files(root, source)
            (root / "config.json").write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "hash_mismatch:model/config.json"):
                models.verify_files(root, source)

    def test_rejects_unlisted_files_and_symlinks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "model").write_bytes(b"model")
            source = models.ModelSource("owner/model", "a" * 40, "model", "Apache-2.0", {"model": models.sha256(root / "model")})
            (root / "extra").write_bytes(b"extra")
            with self.assertRaisesRegex(ValueError, "unexpected_file"):
                models.verify_files(root, source)
            (root / "extra").unlink()
            (root / "link").symlink_to("model")
            with self.assertRaisesRegex(ValueError, "symlink"):
                models.verify_files(root, source)


class RelocationTests(unittest.TestCase):
    def test_license_inventory_includes_named_files_in_license_directories(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            relative = Path("example.dist-info/licenses/BUILD_LICENSES/icu.txt")
            target = root / relative
            target.parent.mkdir(parents=True)
            target.write_text("Upstream copyright and license", encoding="utf-8")
            metadata = Message()
            metadata["Name"] = "example"
            distribution = SimpleNamespace(metadata=metadata, version="1.0", files=[relative], locate_file=lambda file: root / file)
            with patch("collect_licenses.importlib.metadata.distributions", return_value=[distribution]):
                records = collect(root)
            self.assertEqual(records[0]["licenseFiles"], [relative.as_posix()])

    def test_console_script_survives_relocation_into_a_path_with_spaces(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            prefix = root / "python"
            (prefix / "bin").mkdir(parents=True)
            (prefix / "bin/python3").symlink_to(sys.executable)
            script = prefix / "bin/example"
            script.write_text(f"#!{prefix}/bin/python3\nimport sys\nprint(sys.argv[1])\n", encoding="utf-8")
            script.chmod(0o755)
            portable_python(prefix)
            moved = root / "moved python"
            prefix.rename(moved)
            result = subprocess.run([moved / "bin/example", "works with spaces"], text=True, capture_output=True, check=True,
                                    env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
            self.assertEqual(result.stdout.strip(), "works with spaces")


if __name__ == "__main__":
    unittest.main()
