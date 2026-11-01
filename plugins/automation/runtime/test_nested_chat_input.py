"""Real worker/receipt flocks with isolated subprocesses; never launch Apps or post IO."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch
import desktop_jobs as jobs
import chat_requests

HELPER = r'''
import json,sys,time
from pathlib import Path
sys.path.insert(0,sys.argv[1])
import desktop_jobs as jobs
import chat_requests
root=Path(sys.argv[2]);mode=sys.argv[3]
jobs.ROOT=root
jobs.native_input_installed=lambda:True
chat_requests.ROOT=root/'receipts'
chat_requests.GUI_LOCK=root/'gui.lock'
chat_requests.NATIVE_LOCK=root/'native.lock'
def wait_for(path,timeout=5):
    end=time.monotonic()+timeout
    while not path.exists() and time.monotonic()<end:time.sleep(.005)
    if not path.exists():raise RuntimeError('test phase gate timed out')
if mode=='chat':
    def prepare():
        (root/'preparing').touch();wait_for(root/'prepared');return {'session':'owned-session'}
    def dispatch(*args):
        (root/'sent').write_text('once');return {'ok':True,'sent':True}
    def observe(*args):
        (root/'observing').touch();wait_for(root/'finish-chat');return {'ok':True,'status':'completed','reply':'DONE'}
    jobs.execute=lambda *args:chat_requests.submit('zcode','owned-turn','owned-session','test',prepare,dispatch,observe,5)
    jobs.worker('outer')
elif mode=='input':
    jobs.command=lambda request:([sys.executable,__file__,sys.argv[1],str(root),'native'],None)
    jobs.worker('inner')
elif mode=='native':
    with jobs.lock(chat_requests.NATIVE_LOCK,blocking=False):
        (root/'input-held').touch();wait_for(root/'inner.cancel')
    print(json.dumps({'ok':False,'code':'input_stopped','owned_input_at_exit':{'buttons':[],'keys':[]},'events_may_have_been_posted':False}))
'''


class NestedChatInput(unittest.TestCase):
    def test_chat_wait_allows_nested_input_but_dispatch_and_actual_input_remain_exclusive(self):
        with tempfile.TemporaryDirectory(prefix="nested-chat-input-") as temporary:
            root = Path(temporary)
            helper = root / "helper.py"; helper.write_text(HELPER)
            source = str(Path(jobs.__file__).parent)
            processes = []
            def spawn(mode):
                process = subprocess.Popen([sys.executable,str(helper),source,str(root),mode],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
                processes.append(process)
                return process
            def wait_for(condition):
                end = time.monotonic()+3
                while not condition() and time.monotonic()<end:
                    time.sleep(.005)
                self.assertTrue(condition(),"isolated test phase did not complete")
            def queued(request):
                job = {"id":request["request_id"],"operation":request["operation"],"request":request,"status":"queued","created_at":time.time(),"updated_at":time.time(),"error":None,"result":None}
                jobs.save(jobs.job_path(job["id"]),job)
            with patch.object(jobs,"ROOT",root), patch.object(jobs,"native_input_installed",return_value=True), patch.multiple(chat_requests,ROOT=root/"receipts",GUI_LOCK=root/"gui.lock",NATIVE_LOCK=root/"native.lock"):
                outer = {"request_id":"outer","operation":"chat","app":"zcode","mode":"send","target":"owned-session","message":"test","timeout":10}
                inner = {"request_id":"inner","operation":"input","mode":"execute","timeout":5,"target":{"pid":123,"bundle_id":"test.app","window_id":456,"frame":{"x":0,"y":30,"width":900,"height":700},"observed_at_ms":time.time()*1000},"coordinates":{"space":"window","unit":"points"},"action":{"kind":"key","key":"a"}}
                queued(outer); queued(inner)
                try:
                    chat = spawn("chat"); wait_for(lambda:(root/"preparing").exists())
                    queued({"request_id":"during-dispatch","operation":"script","mode":"exec","path":"/usr/bin/true"})
                    with patch.object(jobs,"execute") as execute:
                        jobs.worker("during-dispatch")
                        execute.assert_not_called()
                    self.assertEqual(jobs.get("during-dispatch")["status"],"failed")
                    (root/"prepared").touch(); wait_for(lambda:(root/"observing").exists())
                    queued({**outer,"request_id":"other-chat"})
                    with patch.object(jobs,"execute") as execute:
                        jobs.worker("other-chat")
                        execute.assert_not_called()
                    self.assertEqual(jobs.get("other-chat")["status"],"failed")
                    native = spawn("input"); wait_for(lambda:(root/"input-held").exists() or native.poll() is not None)
                    self.assertTrue((root/"input-held").exists(),json.dumps(jobs.get("inner")))
                    self.assertEqual(jobs.get("outer")["status"],"running")
                    queued({"request_id":"during-input","operation":"script","mode":"exec","path":"/usr/bin/true"})
                    with patch.object(jobs,"execute") as execute:
                        jobs.worker("during-input")
                        execute.assert_not_called()
                    self.assertEqual(jobs.get("during-input")["status"],"failed")
                    dispatch = Mock()
                    refused = chat_requests.submit("zcode","other-turn","other-session","test",lambda:{},dispatch,lambda *args:{},1)
                    dispatch.assert_not_called()
                    self.assertEqual(refused["status"],"busy")
                    jobs.input_stop(True)
                    native.wait(timeout=3)
                    result = jobs.get("inner")
                    self.assertEqual(result["status"],"cancelled")
                    self.assertEqual(result["result"]["owned_input_at_exit"],{"buttons":[],"keys":[]})
                    self.assertEqual(jobs.get("outer")["status"],"running")
                    self.assertFalse(jobs.status()["desktop_busy"],"model observation still owns the desktop")
                    jobs.input_stop(False)
                    with patch.object(subprocess,"Popen") as again:
                        self.assertTrue(jobs.submit(inner)["reused"])
                        again.assert_not_called()
                    (root/"finish-chat").touch(); chat.wait(timeout=3)
                    self.assertEqual(jobs.get("outer")["status"],"completed")
                    self.assertEqual((root/"sent").read_text(),"once")
                finally:
                    for marker in ("prepared","finish-chat","inner.cancel"):(root/marker).touch(exist_ok=True)
                    for process in processes:
                        try: process.communicate(timeout=6)
                        except subprocess.TimeoutExpired:
                            process.terminate(); process.communicate(timeout=2)
