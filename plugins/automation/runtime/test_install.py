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
                if argv[0] == "/usr/bin/osascript":
                    return subprocess.CompletedProcess(argv,0,"0")
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
            with patch("pathlib.Path.home", return_value=home), patch("sys.argv", ["install.py", "--rollback"]), patch("sys.platform", "darwin"), patch("subprocess.run", side_effect=lambda argv, **kwargs: subprocess.CompletedProcess(argv,0,"0") if argv[0]=="/usr/bin/osascript" else result), contextlib.redirect_stdout(io.StringIO()):
                installer.install()
            self.assertEqual((target / "desktop-automation").read_text(), "previous")
            self.assertEqual((previous / "desktop-automation").read_text(), "current")

    def test_localized_migration_and_rollback_restore_app_cli_and_toolkit(self):
        with tempfile.TemporaryDirectory() as directory:
            home=Path(directory)
            def app(path,marker):
                (path/"Contents").mkdir(parents=True)
                (path/"Contents/Info.plist").write_bytes(plistlib.dumps({"CFBundleIdentifier":installer.BUNDLE_ID}))
                (path/"marker").write_text(marker)
            legacy=home/"Agent Script Runner.app"
            app(legacy,"old")
            (home/"agent-script-runner").write_text("old wrapper")
            candidate=home/"candidate"/installer.APP_FILE
            app(candidate,"new")
            target=home/".local/libexec/mini-archipel-desktop"
            target.mkdir(parents=True);(target/"desktop-automation").write_text("old toolkit")
            def run(argv,**kwargs):
                if argv[0]=="/usr/bin/osascript":return subprocess.CompletedProcess(argv,0,"0")
                if argv[0]=="/usr/bin/xcrun":Path(argv[-1]).write_text("compiled helper")
                return subprocess.CompletedProcess(argv,0,json.dumps({"data":{"jobs":[]}}))
            with patch("pathlib.Path.home",return_value=home),patch("sys.platform","darwin"),patch("subprocess.run",side_effect=run),contextlib.redirect_stdout(io.StringIO()):
                with patch("sys.argv",["install.py","--companion",str(candidate)]):installer.install()
                current=home/"Applications"/installer.APP_FILE
                self.assertEqual((current/"marker").read_text(),"new")
                self.assertFalse(legacy.exists())
                backup=Path(json.loads((target/"companion-backup.json").read_text())["directory"])
                self.assertEqual((backup/"legacy.app/marker").read_text(),"old")
                with patch("sys.argv",["install.py","--rollback"]):installer.install()
                self.assertFalse(current.exists())
                self.assertEqual((legacy/"marker").read_text(),"old")
                self.assertEqual((home/"agent-script-runner").read_text(),"old wrapper")
                self.assertEqual((target/"desktop-automation").read_text(),"old toolkit")


if __name__ == "__main__":
    unittest.main()
