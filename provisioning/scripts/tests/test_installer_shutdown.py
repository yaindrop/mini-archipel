import os
import subprocess
import tempfile
import unittest
from pathlib import Path


class InstallerShutdownTests(unittest.TestCase):
    def test_rollback_remembers_a_live_pid_after_its_launchd_label_disappears(self):
        root = Path(__file__).resolve().parents[3]
        for component in ("agent", "console"):
            with (
                self.subTest(component=component),
                tempfile.TemporaryDirectory() as work,
            ):
                home = Path(work)
                source = (root / component / "install.sh").read_text()
                stop = source[source.index("STOP_PID=") : source.index("MOVED=false")]
                stop = stop.replace("{1..200}", "{1..2}")
                (home / ".loaded").touch()
                launchctl = home / "launchctl"
                launchctl.write_text(
                    '#!/bin/bash\ncase "$1" in\n'
                    'print) [[ -f "$HOME/.loaded" ]] || exit 1; '
                    'echo "pid = $FIXTURE_PID";;\n'
                    'bootout) rm -f "$HOME/.loaded";;\nesac\n'
                )
                launchctl.chmod(0o700)
                sleep = home / "sleep"
                sleep.write_text("#!/bin/sh\nexit 0\n")
                sleep.chmod(0o700)
                child = subprocess.Popen(["/bin/sleep", "120"])
                try:
                    result = subprocess.run(
                        [
                            "/bin/bash",
                            "-c",
                            stop + "\n"
                            "first=0; second=0; stop_service || first=$?; "
                            "stop_service || second=$?; "
                            'printf "%s %s %s" "$first" "$second" "$STOP_PID"',
                        ],
                        env={
                            **os.environ,
                            "HOME": work,
                            "PATH": work + ":" + os.environ["PATH"],
                            "LABEL": "fixture",
                            "FIXTURE_PID": str(child.pid),
                        },
                        capture_output=True,
                        text=True,
                        timeout=20,
                        check=True,
                    )
                    self.assertEqual(result.stdout, f"1 1 {child.pid}")
                    self.assertIsNone(child.poll())
                finally:
                    child.terminate()
                    child.wait(timeout=5)
