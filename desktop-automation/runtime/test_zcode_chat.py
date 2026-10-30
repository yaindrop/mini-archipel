import json
from pathlib import Path
import runpy
import sqlite3
import unittest
from unittest.mock import patch

api = runpy.run_path(str(Path(__file__).with_name("zcode-chat")))


class Replies(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            CREATE TABLE message(id TEXT,session_id TEXT,sequence INTEGER,data TEXT);
            CREATE TABLE part(message_id TEXT,sequence INTEGER,data TEXT);
            CREATE TABLE turn_usage(turn_id TEXT,session_id TEXT,user_message_id TEXT,status TEXT,started_at INTEGER,duration_ms INTEGER,tool_call_count INTEGER);
        """)
        for identifier, sequence, data in [("human", 0, {"role": "user"}), ("context", 1, {"role": "user"}), ("answer", 2, {"role": "assistant", "parentID": "human"}), ("unrelated", 3, {"role": "assistant", "parentID": "another"})]:
            self.db.execute("INSERT INTO message VALUES(?,?,?,?)", (identifier, "session", sequence, json.dumps(data)))
        for message, sequence, kind, text in [("context", 0, "text", "Internal context"), ("answer", 0, "reasoning", "PRIVATE"), ("answer", 1, "text", "ACK"), ("unrelated", 0, "text", "WRONG")]:
            self.db.execute("INSERT INTO part VALUES(?,?,?)", (message, sequence, json.dumps({"type": kind, "text": text})))
        self.db.execute("INSERT INTO turn_usage VALUES('turn','session','human','completed',1,42,0)")
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def read(self):
        with patch.dict(api["latest_reply"].__globals__, {"connect": lambda: self.db}):
            return api["latest_reply"]("session")

    def test_internal_user_context_does_not_replace_actual_turn(self):
        result = self.read()
        self.assertEqual((result["status"], result["reply"]), ("completed", "ACK"))

    def test_latest_running_turn_does_not_return_old_reply(self):
        self.db.execute("INSERT INTO turn_usage VALUES('new','session','new_input','running',2,NULL,0)")
        self.db.commit()
        result = self.read()
        self.assertEqual(result["status"], "running")
        self.assertNotIn("reply", result)


if __name__ == "__main__":
    unittest.main()
