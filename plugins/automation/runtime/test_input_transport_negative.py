"""Offline subprocess transport tests: helper emits JSON and never calls native IO."""
import json
import contextlib
import pathlib
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import desktop_jobs as jobs


class TransportNegativeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="input-transport-")
        self.root = pathlib.Path(self.temp.name)
        self.patch = patch.object(jobs, "ROOT", self.root)
        self.patch.start()
        self.native_patch = patch.object(jobs,"native_input_installed",return_value=True)
        self.native_patch.start()

    def tearDown(self):
        self.native_patch.stop()
        self.patch.stop()
        self.temp.cleanup()

    def helper(self, result, ready=True):
        p = self.root / "helper.py"
        p.write_text('import pathlib,sys,time,json\n'
                     'marker=pathlib.Path(sys.argv[1])\n'
                     'end=time.monotonic()+2\n'
                     'while not marker.exists() and time.monotonic()<end: time.sleep(.005)\n'
                     'if not marker.exists(): raise RuntimeError("no cancel marker")\n'
                     f'print(json.dumps({result!r}),flush=True)\n')
        return [sys.executable, str(p), str(self.root / "negative.cancel")]

    def test_deadline_sets_durable_marker_and_preserves_release_receipt(self):
        proof = {"ok":False,"code":"input_stopped","owned_input_at_exit":{"buttons":[],"keys":[]},"events_may_have_been_posted":True,"event_log":"test-events"}
        with patch.object(jobs.os, "killpg") as kill:
            result = jobs.execute(self.helper(proof), None, {"id":"negative","operation":"input"}, time.monotonic()+.05)
        self.assertTrue((self.root / "negative.cancel").exists())
        self.assertEqual(result["status"], "timed_out")
        self.assertEqual(result["owned_input_at_exit"], proof["owned_input_at_exit"])
        self.assertEqual(result["event_log"], "test-events")
        self.assertFalse(result["ok"])
        kill.assert_not_called()

    def test_cancel_sets_false_even_if_helper_late_reports_success(self):
        (self.root / "negative.cancel").touch()
        proof = {"ok":True,"owned_input_at_exit":{"buttons":[],"keys":[]},"code":"input_posted"}
        result = jobs.execute(self.helper(proof), None, {"id":"negative","operation":"input"}, time.monotonic()+2)
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "cancelled")
        self.assertEqual(result["owned_input_at_exit"], proof["owned_input_at_exit"])

    def test_invalid_native_reply_cannot_be_treated_as_completed(self):
        with self.assertRaises(jobs.Failure):
            jobs.execute([sys.executable,"-c",'print("not-json")'],None,{"id":"negative","operation":"input"},time.monotonic()+2)

    def test_input_worker_uses_15_second_default_before_native_dispatch(self):
        request = {"request_id":"negative","operation":"input","mode":"preflight",
                   "target":{"pid":123,"bundle_id":"test.app","window_id":456,"frame":{"x":0,"y":30,"width":900,"height":700},"observed_at_ms":time.time()*1000},
                   "coordinates":{"space":"window","unit":"points"},"action":{"kind":"key","key":"a"}}
        job = {"id":"negative","operation":"input","request":request,"status":"queued","created_at":time.time(),"updated_at":time.time(),"error":None,"result":None}
        jobs.save(jobs.job_path("negative"),job)
        with patch.object(jobs.chat_requests,"desktop",contextlib.nullcontext), patch.object(jobs.time,"monotonic",return_value=100.0), patch.object(jobs,"execute",return_value={"ok":True}) as execute:
            jobs.worker("negative")
        self.assertEqual(execute.call_args.args[3],115.0)

    def test_uncertain_spawn_is_not_replayed_and_conflict_leaves_original_bytes(self):
        request = {"request_id":"negative","operation":"input","mode":"preflight","timeout":15,
                   "target":{"pid":123,"bundle_id":"test.app","window_id":456,"frame":{"x":-1000,"y":30,"width":900,"height":700},"observed_at_ms":time.time()*1000},
                   "coordinates":{"space":"window","unit":"points"},"action":{"kind":"key","key":"a"}}
        with patch.object(jobs.subprocess,"Popen",side_effect=OSError("uncertain spawn")) as spawn:
            first=jobs.submit(request)
            path=jobs.job_path("negative"); original=path.read_bytes()
            second=jobs.submit(request)
            changed=json.loads(json.dumps(request)); changed["mode"]="execute"
            with self.assertRaises(jobs.Failure): jobs.submit(changed)
        self.assertEqual(first["job"]["status"],"failed")
        self.assertTrue(second["reused"])
        self.assertEqual(spawn.call_count,1)
        self.assertEqual(path.read_bytes(),original)


if __name__ == "__main__":
    unittest.main()
