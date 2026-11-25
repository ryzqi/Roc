"""A repaired audit must not overwrite the original scoring evidence."""
import json
from pathlib import Path
import tempfile
import unittest

from reaudit import reaudit
from score_arm import CONFIG_PATH, sha256
import test_score_arm


class ReauditTests(unittest.TestCase):
    def test_original_evidence_is_unchanged_and_source_drift_is_explicit(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / "source", Path(directory) / "audit"
            _, metrics_path, metrics = test_score_arm.DenominatorAuditTests().fixture(source)
            metrics["display_formula"]["all"] = {"CDM": {"all": 0.0}}
            metrics["table"]["all"] = {"TEDS": {"all": 0.0}}
            metrics_path.write_text(json.dumps(metrics))
            for name, script in (("started.json", "a" * 64), ("report.json", "b" * 64)):
                (source / name).write_text(json.dumps({"configurationSha256": sha256(CONFIG_PATH), "scriptSha256": script}))
            (source / "official-config.json").write_text('{}')
            (source / "official.log").write_text('finished')
            before = {str(p): p.read_bytes() for p in source.rglob('*') if p.is_file()}
            result = reaudit(source, output)
            self.assertEqual(result["status"], "qualified-gold-denominator")
            self.assertTrue(result["runnerFileChangedDuringRun"])
            self.assertFalse(result["automaticAdoption"])
            self.assertEqual(before, {str(p): p.read_bytes() for p in source.rglob('*') if p.is_file()})
            with self.assertRaises(FileExistsError):
                reaudit(source, output)


if __name__ == "__main__":
    unittest.main()
