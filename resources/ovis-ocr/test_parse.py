"""Verify parser integrity handoff without importing MLX or loading a model."""

import argparse
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("ovis_parse", Path(__file__).with_name("parse.py"))
parser = importlib.util.module_from_spec(spec)
spec.loader.exec_module(parser)


class BeforeModelLoad(Exception):
    pass


class VerificationHandoffTests(unittest.TestCase):
    def test_bootstrap_result_is_consumed_once_and_direct_entry_still_verifies(self):
        root = Path("/installation")
        verified = (root / "model-8bit", "prompt", {})
        args = argparse.Namespace(installation=root, pages=Path("/pages.json"), output=Mock())
        args.output.mkdir.side_effect = BeforeModelLoad
        with patch.object(parser, "require_offline"), patch.object(parser, "read_pages", return_value=[]), \
                patch.object(parser, "verify_installation", return_value=verified) as verify:
            # Bootstrap validates before importing installed packages, then passes its result in-process.
            value = parser.verify_installation(root)
            with self.assertRaises(BeforeModelLoad):
                parser.parse_document(args, value, 0.25)
            self.assertEqual(verify.call_count, 1)
            verify.reset_mock()
            with self.assertRaises(BeforeModelLoad):
                parser.parse_document(args)
            verify.assert_called_once_with(root)

    def test_handoff_is_bound_to_root_and_cannot_be_requested_by_cli(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            argv = ["parse.py", "--installation", str(root), "--pages", str(root / "pages.json"),
                    "--output", str(root / "out"), "--offline-worker"]
            verified = (root / "model-8bit", "prompt", {})
            with patch.object(parser.sys, "argv", argv), patch.object(parser.platform, "system", return_value="Darwin"), \
                    patch.object(parser.platform, "machine", return_value="arm64"), \
                    patch.object(parser, "parse_document", return_value=0) as parse, \
                    patch.object(parser.signal, "signal"), patch.object(parser.sys, "stderr"):
                self.assertEqual(parser.main_with_verified_installation(root, verified, 0.25), 0)
                self.assertIs(parse.call_args.args[1], verified)
                self.assertEqual(parse.call_args.args[2], 0.25)
                parse.reset_mock()
                with self.assertRaises(SystemExit):
                    parser.main_with_verified_installation(root / "other", verified, 0.25)
                parse.assert_not_called()
                with patch.object(parser.sys, "argv", [*argv, "--skip-verification"]):
                    with self.assertRaises(SystemExit):
                        parser.main()
                parse.assert_not_called()


if __name__ == "__main__":
    unittest.main()
