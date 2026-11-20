"""Integrity regressions for source replay; synthetic bytes are not gold."""
import copy
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "sciegqa_sources", ROOT / "scripts/prepare-scientific-sciegqa-sources.py")
sources = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sources)


class Response(io.BytesIO):
    status = 200


class SourceReplay(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        # macOS's default /var temporary directory is an OS symlink.
        self.base = Path(self.tmp.name).resolve()
        self.root = self.base / "sources"
        self.lock = json.loads(sources.LOCK.read_bytes())
        self.content = {}
        for i, pin in enumerate(self.lock["files"]):
            data = f"immutable source {i}\n".encode()
            self.content[pin["url"]] = data
            pin["bytes"] = len(data)
            pin["sha256"] = sources.hashlib.sha256(data).hexdigest()

    def opener(self, request, timeout):
        self.assertEqual(timeout, 45)
        return Response(self.content[request.full_url])

    def test_exact_replay_never_reconnects(self):
        first = sources.prepare(self.root, lock=self.lock, opener=self.opener)
        second = sources.prepare(self.root, offline=True, lock=self.lock,
                                 opener=lambda *_args, **_kwargs: self.fail("offline network"))
        self.assertEqual(first, second)
        self.assertFalse(second["scientificBaselineReady"])
        self.assertEqual(list(self.root.glob(".*.acquiring-*")), [])

    def test_existing_corruption_is_preserved(self):
        sources.prepare(self.root, lock=self.lock, opener=self.opener)
        path = self.root / "PDF.tar"
        path.write_bytes(b"corrupt")
        with self.assertRaisesRegex(ValueError, "source_changed"):
            sources.prepare(self.root, lock=self.lock,
                            opener=lambda *_args, **_kwargs: self.fail("repair network"))
        self.assertEqual(path.read_bytes(), b"corrupt")

    def test_truncated_overrun_and_wrong_hash_are_not_published(self):
        for replacement in (b"x", b"x" * 100, b"x" * self.lock["files"][0]["bytes"]):
            with self.subTest(replacement=len(replacement)):
                root = sources.checked_root(self.root, create=True)
                with self.assertRaisesRegex(ValueError, "download_(changed|too_large)"):
                    sources.download(self.lock["files"][0], root,
                                     opener=lambda *_args, **_kwargs: Response(replacement))
                self.assertEqual(list(root.iterdir()), [])

    def test_invalid_lock_paths_urls_hashes_and_sizes(self):
        for change in (
            {"path": "../README.md"}, {"bytes": True}, {"bytes": 0},
            {"bytes": sources.MAX_BYTES + 1}, {"sha256": "f" * 63},
            {"url": self.lock["files"][0]["url"].replace("https:", "http:")},
            {"url": self.lock["files"][0]["url"] + "?download=true"},
            {"url": self.lock["files"][0]["url"].replace("huggingface.co", "example.org")},
        ):
            with self.subTest(change=change):
                lock = copy.deepcopy(self.lock)
                lock["files"][0].update(change)
                with self.assertRaises(ValueError):
                    sources.prepare(self.root, lock=lock, opener=self.opener)
        lock = copy.deepcopy(self.lock)
        for pin in lock["files"]:
            pin["bytes"] = sources.MAX_BYTES
        with self.assertRaisesRegex(ValueError, "byte_budget_exceeded"):
            sources.validate_lock(lock)
        self.assertFalse(self.root.exists())

    def test_missing_offline_input_remains_missing(self):
        self.root.mkdir()
        with self.assertRaisesRegex(ValueError, "source_missing"):
            sources.prepare(self.root, offline=True, lock=self.lock)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_symlink_root_parent_and_source_are_rejected(self):
        external = self.base / "external"
        external.mkdir()
        link = self.base / "linked"
        link.symlink_to(external, target_is_directory=True)
        for root in (link, link / "nested"):
            with self.subTest(root=root):
                with self.assertRaisesRegex(ValueError, "path_invalid"):
                    sources.prepare(root, lock=self.lock, opener=self.opener)
        sources.prepare(self.root, lock=self.lock, opener=self.opener)
        path = self.root / "PDF.tar"
        path.unlink()
        target = external / "archive"
        target.write_bytes(self.content[self.lock["files"][2]["url"]])
        path.symlink_to(target)
        with self.assertRaisesRegex(ValueError, "source_missing"):
            sources.prepare(self.root, offline=True, lock=self.lock)
        self.assertTrue(path.is_symlink())

    def test_publication_cannot_replace_another_owner(self):
        root = sources.checked_root(self.root, create=True)
        target = root / "README.md"
        target.write_bytes(b"other owner")
        with self.assertRaises(FileExistsError):
            sources.download(self.lock["files"][0], root, opener=self.opener)
        self.assertEqual(target.read_bytes(), b"other owner")
        self.assertEqual(list(root.glob(".*.acquiring-*")), [])


if __name__ == "__main__":
    unittest.main()
