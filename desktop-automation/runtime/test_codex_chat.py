"""Reply matching must not accept a different turn or a partial JSONL write."""
import io
import json
from pathlib import Path
import runpy
import tempfile
import unittest

api = runpy.run_path(str(Path(__file__).with_name("codex-chat")))


def event(kind, **payload):
    return {"type": "event_msg", "payload": {"type": kind, **payload}}


def stream(*rows):
    return io.BytesIO(b"".join(json.dumps(row).encode() + b"\n" for row in rows))


class Replies(unittest.TestCase):
    def test_only_matching_message_and_turn_can_complete(self):
        data = stream(
            event("task_complete", turn_id="old", last_agent_message="OLD"),
            event("task_started", turn_id="new"),
            {"type": "response_item", "payload": {"role": "user", "content": [{"type": "input_text", "text": "测试\n"}]}},
            event("task_complete", turn_id="unrelated", last_agent_message="WRONG"),
            event("task_complete", turn_id="new", last_agent_message="RIGHT", duration_ms=100),
        )
        result = api["wait_reply"](data, "测试", 0.1)
        self.assertEqual((result["turn_id"], result["reply"]), ("new", "RIGHT"))

    def test_matching_turn_without_matching_user_message_is_unconfirmed(self):
        result = api["wait_reply"](stream(event("task_started", turn_id="new"), event("task_complete", turn_id="new", last_agent_message="WRONG")), "测试", 0.001)
        self.assertEqual(result["status"], "send_unconfirmed")

    def test_partial_line_is_retained_until_append_finishes(self):
        row = json.dumps(event("task_started", turn_id="new")).encode()
        data = io.BytesIO(row)
        self.assertEqual(list(api["records"](data)), [])
        self.assertEqual(data.tell(), 0)
        data.seek(0, 2); data.write(b"\n"); data.seek(0)
        self.assertEqual(len(list(api["records"](data))), 1)

    def test_reverse_reader_crosses_chunk_boundaries_and_ignores_partial_tail(self):
        first = event("task_started", turn_id="new")
        last = event("task_complete", turn_id="new", last_agent_message="DONE")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "chat.jsonl"
            path.write_bytes(stream(first, {"long_record": "x" * 150000}, last).getvalue() + b'{"partial":')
            rows = list(api["reverse_records"](path))
            self.assertEqual((rows[0], rows[-1], len(rows)), (last, first, 3))
            self.assertEqual(api["latest_reply"]({"id": "chat", "rollout_path": str(path)})["reply"], "DONE")

    def test_new_running_turn_wins_over_older_completed_reply(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "chat.jsonl"
            path.write_bytes(stream(event("task_complete", turn_id="old", last_agent_message="OLD"), event("task_started", turn_id="new")).getvalue())
            result = api["latest_reply"]({"id": "chat", "rollout_path": str(path)})
            self.assertEqual((result["status"], result["turn_id"]), ("running", "new"))
            self.assertNotIn("reply", result)


if __name__ == "__main__":
    unittest.main()
