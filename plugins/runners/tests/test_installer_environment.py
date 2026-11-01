import hashlib
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


class InstallerEnvironmentTests(unittest.TestCase):
    def test_installs_own_hooks_without_a_flowbit_checkout_or_runner(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            profile = home / "profile.json"
            token = home / "registration.json"
            archive = home / "runner.tar.gz"
            archive.write_bytes(b"fixture archive")
            profile.write_text(
                json.dumps(
                    {
                        "node": "fixture",
                        "repositories": [],
                        "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
                    }
                )
            )
            token.write_text("{}")
            token.chmod(0o600)
            path = Path(__file__).parents[1] / "scripts/install-node-runners.py"
            spec = importlib.util.spec_from_file_location("installer", path)
            installer = importlib.util.module_from_spec(spec)
            previous_umask = os.umask(0o077)
            try:
                with patch(
                    "sys.argv", [str(path), str(profile), str(token), str(archive)]
                ):
                    spec.loader.exec_module(installer)
                with (
                    patch.object(installer, "HOME", home),
                    patch.object(installer, "ROOT", home / "runners"),
                    patch.object(installer, "workers", return_value=[]),
                    patch.dict(os.environ, {"PATH": "/usr/bin:/bin"}, clear=True),
                ):
                    self.assertEqual(installer.main(), 0)
                hooks = home / ".local/libexec/mini-archipel/ci"
                for name in [
                    "ci-lease.py",
                    "ci-housekeeping.py",
                    "job-started.sh",
                    "job-completed.sh",
                ]:
                    self.assertEqual(
                        (hooks / name).read_bytes(), (path.parent / name).read_bytes()
                    )
                    self.assertEqual((hooks / name).stat().st_mode & 0o777, 0o755)
                self.assertFalse(token.exists())
                self.assertFalse((home / "runners/flowbit").exists())
            finally:
                os.umask(previous_umask)


if __name__ == "__main__":
    unittest.main()
