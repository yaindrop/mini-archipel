import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import chat_requests as requests


class Receipts(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.patch = patch.multiple(requests, ROOT=self.root / "receipts", GUI_LOCK=self.root / "gui.lock", NATIVE_LOCK=self.root / "native.lock")
        self.patch.start()
        self.sends = 0

    def tearDown(self):
        self.patch.stop()
        self.directory.cleanup()

    def send(self, checkpoint, message):
        self.sends += 1
        self.assertIsNotNone(requests.GUI_LOCK_FD)
        return {"ok": True, "sent": True}

    def submit(self, observer, dispatch=None, message="test"):
        return requests.submit("codex", "test-request", "target", message,
                               lambda: {"offset": 42}, dispatch or self.send, observer, .01)

    def test_timeout_recovery_and_repeated_submit_dispatch_once(self):
        first = self.submit(lambda *args: {"ok": False, "status": "waiting", "accepted": True})
        self.assertEqual(first["status"], "waiting")
        second = self.submit(lambda *args: {"ok": True, "status": "completed", "reply": "DONE"})
        third = self.submit(lambda *args: self.fail("Completed receipt should be cached"))
        self.assertEqual((second["reply"], third["reply"], self.sends), ("DONE", "DONE", 1))

    def test_lost_dispatch_ack_is_reconciled_without_resend(self):
        def crash(*args):
            self.sends += 1
            raise RuntimeError("lost stdout after sending")
        result = self.submit(lambda *args: {"ok": True, "status": "completed", "reply": "DONE"}, crash)
        self.assertEqual(result["status"], "completed")
        self.submit(lambda *args: self.fail("Unexpected retry"))
        self.assertEqual(self.sends, 1)

    def test_request_id_cannot_be_reused_with_changed_content(self):
        self.submit(lambda *args: {"ok": True, "status": "completed"})
        with self.assertRaisesRegex(ValueError, "different target or message"):
            self.submit(lambda *args: None, message="different")
        self.assertEqual(self.sends, 1)

    def test_click_with_unknown_ack_stays_recoverable(self):
        def uncertain(*args):
            self.sends += 1
            return {"ok": False, "sent": None, "error": "AX acknowledgement timed out"}
        result = self.submit(lambda *args: {"ok": False, "status": "send_unconfirmed"}, uncertain)
        self.assertIsNone(result["sent"])
        self.assertEqual(result["status"], "send_unconfirmed")
        result = self.submit(lambda *args: {"ok": True, "sent": True, "status": "completed", "reply": "DONE"})
        self.assertEqual((result["status"], self.sends), ("completed", 1))

    def test_not_sent_is_terminal_until_caller_uses_a_new_id(self):
        first = self.submit(lambda *args: self.fail("Nothing was sent"), lambda *args: {"ok": False, "sent": False, "error": "Draft exists"})
        second = self.submit(lambda *args: self.fail("No resend"))
        self.assertEqual((first["status"], second["status"], self.sends), ("not_sent", "not_sent", 0))

    def test_uncertain_dispatch_releases_gui_before_observation_but_keeps_receipt_owned(self):
        def observe(*args):
            with requests.locked(requests.GUI_LOCK), requests.locked(requests.NATIVE_LOCK):
                pass
            same = self.submit(lambda *args: self.fail("Same owned receipt must not observe or resend"))
            self.assertEqual(same["status"],"in_progress")
            return {"ok":False,"status":"send_unconfirmed"}
        def uncertain(*args):
            self.sends += 1
            return {"ok":False,"sent":None}
        first = self.submit(observe,uncertain)
        self.assertEqual(first["status"],"send_unconfirmed")
        second = self.submit(lambda *args:{"ok":True,"status":"completed","reply":"DONE"})
        self.assertEqual(second["status"],"completed")
        self.submit(lambda *args:self.fail("Completed receipt must stay cached"))
        self.assertEqual(self.sends,1)

    def test_busy_desktop_does_not_create_a_dispatch_receipt(self):
        with requests.locked(requests.GUI_LOCK):
            result = self.submit(lambda *args: None)
        self.assertEqual(result["status"], "busy")
        self.assertEqual(self.sends, 0)
        self.assertFalse(requests.receipt_path("codex", "test-request").exists())

    def test_receipt_is_private_and_written_before_dispatch(self):
        def inspect(*args):
            path = requests.receipt_path("codex", "test-request")
            self.assertEqual(json.loads(path.read_text())["stage"], "dispatching")
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            return {"ok": False, "sent": False}
        self.submit(lambda *args: None, inspect)

    def test_orphaned_native_action_blocks_before_activation(self):
        with requests.locked(requests.NATIVE_LOCK):
            result = self.submit(lambda *args: None)
        self.assertEqual((result["status"], self.sends), ("busy", 0))

    def test_history_read_failure_retains_receipt_and_never_resends(self):
        def unavailable(*args):
            raise OSError("history temporarily unavailable")
        result = self.submit(unavailable)
        self.assertEqual((result["status"], result["request_id"]), ("verification_error", "test-request"))
        result = self.submit(lambda *args: {"ok": True, "status": "completed", "reply": "DONE"})
        self.assertEqual((result["reply"], self.sends), ("DONE", 1))


if __name__ == "__main__":
    unittest.main()
