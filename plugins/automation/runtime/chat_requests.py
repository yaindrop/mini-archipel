"""Durable at-most-once dispatch receipts shared by both desktop adapters."""
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import uuid

ROOT = Path.home() / ".agent-chat-requests"
GUI_LOCK = Path.home() / ".codex-chat.lock"
NATIVE_LOCK = Path.home() / ".agent-chat-native.lock"
GUI_LOCK_FD = None
TERMINAL = {"completed", "aborted", "interrupted", "error", "cancelled", "not_sent"}


class BusyError(Exception):
    pass


@contextmanager
def locked(path):
    global GUI_LOCK_FD
    with open(path, "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise BusyError("Another call is using this request or the desktop")
        previous = GUI_LOCK_FD
        if Path(path) == GUI_LOCK:
            GUI_LOCK_FD = lock.fileno()
        try:
            yield lock
        finally:
            GUI_LOCK_FD = previous


def ui_process(command):
    # Keep the desktop lock alive in the runner if the SSH caller is killed.
    return subprocess.run(command, capture_output=True, text=True,
                          pass_fds=(GUI_LOCK_FD,) if GUI_LOCK_FD is not None else ())


@contextmanager
def desktop():
    with locked(GUI_LOCK):
        # Check before activation too: an orphan may still be editing a window.
        with locked(NATIVE_LOCK):
            pass
        yield


def receipt_path(app, request_id):
    if app not in {"codex", "zcode"} or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", request_id):
        raise ValueError("Invalid request ID: use 1–100 letters, digits, underscores or hyphens")
    ROOT.mkdir(mode=0o700, exist_ok=True)
    return ROOT / f"{app}-{request_id}.json"


def save(path, receipt):
    receipt["updated_at"] = time.time()
    fd, temporary = tempfile.mkstemp(prefix=".receipt-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(receipt, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def output(receipt, result, reused):
    return {**result, "request_id": receipt["request_id"], "reused": reused}


def reconcile(path, receipt, observe, timeout, reused=True):
    if receipt.get("result", {}).get("status") in TERMINAL:
        return output(receipt, receipt["result"], reused)
    try:
        result = observe(receipt["checkpoint"], receipt["message"], timeout)
    except Exception as error:
        result = {"ok": False, "status": "verification_error", "error": str(error)}
    result = {**receipt.get("dispatch", {}), **result}
    receipt["result"] = result
    save(path, receipt)
    return output(receipt, result, reused)


def recover(app, request_id, observe, timeout):
    path = receipt_path(app, request_id)
    if not path.exists():
        raise ValueError("No receipt exists for this request ID")
    try:
        with locked(path.with_suffix(".lock")):
            return reconcile(path, json.loads(path.read_text()), observe, timeout)
    except BusyError as error:
        return {"ok": False, "status": "in_progress", "request_id": request_id, "error": str(error)}


def submit(app, request_id, target, message, prepare, dispatch, observe, timeout):
    request_id = request_id or str(uuid.uuid4())
    path = receipt_path(app, request_id)
    started = time.monotonic()
    try:
        with locked(path.with_suffix(".lock")):
            if path.exists():
                receipt = json.loads(path.read_text())
                if receipt["target"] != target or receipt["message"] != message:
                    raise ValueError("Request ID was already used with a different target or message")
                return reconcile(path, receipt, observe, timeout)
            with desktop():
                try:
                    checkpoint = prepare()
                except Exception as error:
                    return {"ok": False, "status": "not_sent", "sent": False, "request_id": request_id, "error": str(error)}
                receipt = {"app": app, "request_id": request_id, "target": target, "message": message,
                           "checkpoint": checkpoint, "stage": "dispatching", "created_at": time.time()}
                # Persist before any paste/click; a lost UI acknowledgement must never cause a resend.
                save(path, receipt)
                try:
                    result = dispatch(checkpoint, message)
                except Exception as error:
                    result = {"ok": False, "sent": None, "status": "send_unconfirmed", "error": str(error)}
                result["control_ms"] = round((time.monotonic() - started) * 1000)
                receipt["dispatch"] = result
                if result.get("sent") is False:
                    result["status"] = "not_sent"
                    receipt["result"] = result
                    save(path, receipt)
                    return output(receipt, result, False)
                receipt["stage"] = "submitted" if result.get("sent") else "dispatch_uncertain"
                save(path, receipt)
            # Model observation is read-only; keep the receipt lock, not the desktop.
            result = reconcile(path, receipt, observe, timeout, reused=False)
            result["total_ms"] = round((time.monotonic() - started) * 1000)
            receipt["result"] = result
            save(path, receipt)
            return result
    except BusyError as error:
        exists = path.exists()
        return {"ok": False, "status": "in_progress" if exists else "busy", "sent": None if exists else False, "request_id": request_id, "error": str(error)}
