from contextlib import contextmanager
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
import sys
import tempfile
from threading import Thread
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from download_asset import RemoteFile, download_ranges, download_verified, probe


@contextmanager
def range_server(data: bytes, *, truncate_first: bool = False, changed: bool = False):
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            match = re.fullmatch(r"bytes=(\d+)-(\d+)", self.headers["Range"])
            start, end = map(int, match.groups())
            requests.append((start, end))
            body = data[start:end + 1]
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{len(data)}")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("ETag", '"changed"' if changed else '"fixed"')
            self.end_headers()
            self.wfile.write(body[:3] if truncate_first and len(requests) == 1 else body)
            self.close_connection = True

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/asset", requests
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


class DownloadTests(unittest.TestCase):
    def test_retains_partial_bytes_and_resumes_across_invocations(self):
        data = b"resume these exact bytes"
        with tempfile.TemporaryDirectory() as temporary, range_server(data, truncate_first=True) as (url, requests):
            target = Path(temporary) / "bundle.tar"
            remote = RemoteFile(url, len(data), '"fixed"')
            with self.assertRaisesRegex(OSError, "chunk_incomplete"):
                download_ranges(remote, target, workers=1, chunk_size=16, attempts=1)
            self.assertEqual((target.parent / "bundle.tar.parts/000000.part").read_bytes(), data[:3])
            self.assertFalse(target.exists())
            download_ranges(remote, target, workers=1, chunk_size=16)
            self.assertEqual(target.read_bytes(), data)
            self.assertIn((3, 15), requests)
            self.assertEqual(requests.count((0, 15)), 1)

    def test_rejects_changed_etag_before_writing_content(self):
        with tempfile.TemporaryDirectory() as temporary, range_server(b"12345", changed=True) as (url, _):
            target = Path(temporary) / "asset"
            with self.assertRaisesRegex(ValueError, "source_changed"):
                download_ranges(RemoteFile(url, 5, '"fixed"'), target)
            self.assertFalse(target.exists())
            self.assertFalse((target.parent / "asset.parts/000000.part").exists())

    def test_verifies_download_and_reuses_verified_file_without_network(self):
        data = b"a small locked asset"
        digest = hashlib.sha256(data).hexdigest()
        with tempfile.TemporaryDirectory() as temporary, range_server(data) as (url, requests):
            target = Path(temporary) / "asset"
            self.assertEqual(probe(url).size, len(data))
            download_verified(url, digest, target, expected_size=len(data))
            self.assertEqual(target.read_bytes(), data)
            count = len(requests)
            download_verified(url, digest, target)
            self.assertEqual(len(requests), count)
            target.write_bytes(b"corrupt")
            with self.assertRaisesRegex(ValueError, "hash_mismatch"):
                download_verified(url, digest, target)

    def test_rejects_symlink_targets_and_cache(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / "asset"
            protected = root / "protected"
            protected.write_text("keep", encoding="utf-8")
            target.symlink_to(protected)
            with self.assertRaisesRegex(ValueError, "target_symlink"):
                download_verified("https://unused.invalid", "a" * 64, target)
            self.assertEqual(protected.read_text(), "keep")
            target.unlink()
            (root / "asset.parts").symlink_to(root, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "cache_symlink"):
                download_ranges(RemoteFile("https://unused.invalid", 10, None), target)

    def test_retries_failed_transfer_without_discarding_partial_bytes(self):
        data = b"a short body with more than three bytes"
        with tempfile.TemporaryDirectory() as temporary, range_server(data, truncate_first=True) as (url, requests):
            target = Path(temporary) / "asset"
            with patch("download_asset.time.sleep"):
                download_ranges(RemoteFile(url, len(data), '"fixed"'), target, workers=1)
            self.assertEqual(target.read_bytes(), data)
            self.assertEqual(requests[1][0], 3)


if __name__ == "__main__":
    unittest.main()
