"""Exercise companion transport cancellation with launch mocked, never native IO."""
import contextlib
import importlib.machinery
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

loader = importlib.machinery.SourceFileLoader("input_runner", str(Path(__file__).with_name("agent-script-runner")))
spec = importlib.util.spec_from_loader(loader.name, loader)
runner = importlib.util.module_from_spec(spec)
loader.exec_module(runner)


class RunnerInput(unittest.TestCase):
    def test_interrupted_launch_latches_cancel_and_preserves_native_release_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            (home / "Applications/Mini Archipel Plugin - Automation.app").mkdir(parents=True)
            job = home / "input-1.json"; job.write_text("{}")
            def launch(argv, **_kwargs):
                directory = Path(argv[-1]).parent
                (directory / "pid").write_text("12345")
                (directory / "result.json").write_text(json.dumps({"ok":False,"exit_code":1,"owned_input_at_exit":{"buttons":[],"keys":[]},"code":"input_stopped"}))
                raise KeyboardInterrupt
            output = io.StringIO()
            with patch.object(Path,"home",return_value=home), patch.object(runner.subprocess,"run",side_effect=launch), patch.object(runner.os,"kill") as kill, contextlib.redirect_stdout(output):
                status = runner.launch(SimpleNamespace(mode="input",job=str(job)))
            self.assertEqual(status,1)
            self.assertTrue(job.with_suffix(".cancel").exists())
            kill.assert_called_once_with(12345,runner.signal.SIGTERM)
            result = json.loads(output.getvalue())
            self.assertFalse(result["ok"])
            self.assertEqual(result["status"],"cancelled")
            self.assertEqual(result["owned_input_at_exit"],{"buttons":[],"keys":[]})
            self.assertNotIn("release_unconfirmed",result)

    def test_missing_companion_reports_normal_error(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(Path,"home",return_value=Path(temporary)):
            with self.assertRaisesRegex(OSError,"Application not installed"):
                runner.launch(SimpleNamespace(mode="input-info"))
