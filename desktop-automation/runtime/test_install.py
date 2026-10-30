import contextlib
import importlib.util
import io
import json
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("desktop_install", Path(__file__).resolve().parents[1] / "install.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class Install(unittest.TestCase):
    def test_compile_failure_preserves_installed_helpers_and_authorized_app(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            app = home / "Agent Script Runner.app/Contents"
            app.mkdir(parents=True)
            with (app / "Info.plist").open("wb") as stream:
                plistlib.dump({"CFBundleIdentifier": "local.yaindrop.agent-script-runner"}, stream)
            marker = app / "authorized-identity"
            marker.write_text("unchanged")
            target = home / ".local/libexec/mini-archipel-desktop"
            target.mkdir(parents=True)
            (target / "desktop-automation").write_text("original")
            def run(argv, **kwargs):
                if argv[0] == "/usr/bin/xcrun":
                    raise subprocess.CalledProcessError(1, argv)
                return subprocess.CompletedProcess(argv, 0, json.dumps({"data": {"jobs": []}}))
            with patch("pathlib.Path.home", return_value=home), patch("sys.argv", ["install.py"]), patch("sys.platform", "darwin"), patch("subprocess.run", side_effect=run):
                with self.assertRaises(subprocess.CalledProcessError):
                    installer.install()
            self.assertEqual((target / "desktop-automation").read_text(), "original")
            self.assertEqual(marker.read_text(), "unchanged")

    def test_explicit_rollback_swaps_only_helper_releases(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            target = home / ".local/libexec/mini-archipel-desktop"
            previous = target.with_name(target.name + ".previous")
            for path, value in [(target, "current"), (previous, "previous")]:
                path.mkdir(parents=True)
                (path / "desktop-automation").write_text(value)
            result = subprocess.CompletedProcess([], 0, json.dumps({"data": {"jobs": []}}))
            with patch("pathlib.Path.home", return_value=home), patch("sys.argv", ["install.py", "--rollback"]), patch("sys.platform", "darwin"), patch("subprocess.run", return_value=result), contextlib.redirect_stdout(io.StringIO()):
                installer.install()
            self.assertEqual((target / "desktop-automation").read_text(), "previous")
            self.assertEqual((previous / "desktop-automation").read_text(), "current")


if __name__ == "__main__":
    unittest.main()
