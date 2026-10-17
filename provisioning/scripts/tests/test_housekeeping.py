import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "housekeeping", Path(__file__).parents[1] / "ci-housekeeping.py"
)
housekeeping = importlib.util.module_from_spec(spec)
spec.loader.exec_module(housekeeping)


class TargetSafetyTests(unittest.TestCase):
    def test_job_without_lease_cannot_enter_maintenance(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp).resolve()
            runner = home / "runners/repo"
            workspace = runner / "_work/repo/repo"
            workspace.mkdir(parents=True)
            (runner / ".runner").write_text("{}")
            with (
                patch.object(housekeeping, "H", home),
                patch.object(housekeeping, "W", workspace),
                patch.object(
                    housekeeping, "run", return_value=subprocess.CompletedProcess([], 1)
                ) as command,
                patch.object(housekeeping, "emit") as emit,
            ):
                housekeeping.main()
                self.assertEqual(command.call_count, 1)
                self.assertEqual(command.call_args.args[0][-1], "owned")
                emit.assert_called_once_with("skipped_without_node_lease")

    def test_only_ignored_untracked_real_target_directories_are_eligible(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            (root / ".gitignore").write_text("generated/target/\ntracked/target/\n")
            for name in ["generated", "tracked", "source"]:
                directory = root / name / "target"
                directory.mkdir(parents=True)
                (directory / "file").write_text("keep or regenerate")
            subprocess.run(
                ["git", "-C", str(root), "add", "-f", "tracked/target/file"], check=True
            )
            self.assertTrue(housekeeping.safe_target(root / "generated/target", root))
            self.assertFalse(housekeeping.safe_target(root / "tracked/target", root))
            self.assertFalse(housekeeping.safe_target(root / "source/target", root))
            (root / "target-link").symlink_to(
                root / "generated/target", target_is_directory=True
            )
            self.assertFalse(housekeeping.safe_target(root / "target-link", root))
            self.assertFalse(
                housekeeping.safe_target(root / "generated/target", root / "source")
            )


if __name__ == "__main__":
    unittest.main()
