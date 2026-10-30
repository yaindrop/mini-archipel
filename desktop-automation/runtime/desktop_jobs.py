"""Node-local, durable jobs. No HTTP server, credentials or shell interpolation."""
import argparse
from contextlib import contextmanager
import fcntl
import json
import os
import platform
import plistlib
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
from contextlib import nullcontext
import chat_requests

SOURCE = Path(__file__).resolve().parent
ROOT = Path.home() / ".local/share/mini-archipel/desktop-automation"
RUNNER = Path.home() / "agent-script-runner"
ACTIVE = {"queued", "running", "waiting_user"}
LIMIT = 1024 * 1024


class Failure(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def job_path(job_id):
    if not isinstance(job_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}", job_id):
        raise Failure("Invalid request_id")
    ROOT.mkdir(parents=True, mode=0o700, exist_ok=True)
    return ROOT / (job_id + ".json")


@contextmanager
def lock(path, blocking=True):
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        yield
    finally:
        os.close(fd)


def save(path, data):
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".save-")
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(data, stream, ensure_ascii=False)
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


def validate(request):
    if not isinstance(request, dict):
        raise Failure("Expected a JSON object")
    operation = request.get("operation")
    fields = {"doctor": set(), "permissions": {"permission"},
              "chat": {"app", "mode", "target", "message", "original_request_id"},
              "script": {"mode", "path", "arguments"}}
    if not isinstance(operation, str) or operation not in fields or set(request) - fields[operation] - {"request_id", "operation", "timeout"}:
        raise Failure("Unknown operation or fields")
    job_path(request.get("request_id"))
    timeout = request.get("timeout", 120)
    if type(timeout) is not int or not 1 <= timeout <= 900:
        raise Failure("timeout must be 1–900 seconds")
    if operation == "permissions" and request.get("permission") not in ("accessibility", "automation"):
        raise Failure("Unsupported permission")
    if operation == "chat":
        app, mode = request.get("app"), request.get("mode")
        if app not in ("codex", "zcode") or mode not in ("send", "new", "read", "probe", "recover"):
            raise Failure("Invalid chat operation")
        if mode == "new" and app != "zcode":
            raise Failure("Codex new chat is not supported by this adapter")
        if mode in {"send", "new"} and (not isinstance(request.get("message"), str) or not request["message"].strip() or len(request["message"]) > 64000):
            raise Failure("A message of at most 64000 characters is required")
        if mode == "recover":
            job_path(request.get("original_request_id"))
        elif mode != "new":
            target = request.get("target")
            pattern = r"[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}" if app == "codex" else r"[A-Za-z0-9_-]{1,160}"
            if not isinstance(target, str) or not re.fullmatch(pattern, target):
                raise Failure("Invalid chat target")
    if operation == "script":
        path, arguments = request.get("path"), request.get("arguments", [])
        if request.get("mode") not in ("run", "exec") or not isinstance(path, str) or not path.startswith("/") or "\0" in path:
            raise Failure("Scripts require run/exec and an absolute node path")
        if not isinstance(arguments, list) or len(arguments) > 100 or any(not isinstance(arg, str) or len(arg) > 8000 or "\0" in arg for arg in arguments):
            raise Failure("Invalid literal script arguments")
    if len(json.dumps(request).encode()) > 300000:
        raise Failure("Request too large")
    return request


def summary(job):
    return {key: job[key] for key in ["id", "operation", "status", "created_at", "updated_at", "error"]}


def get(job_id):
    path = job_path(job_id)
    if not path.exists():
        raise Failure("Job not found", 404)
    job = json.loads(path.read_text())
    if job["status"] in ACTIVE and time.time() - job["updated_at"] > 10:
        try:
            with lock(path.with_suffix(".work"), blocking=False):
                job = json.loads(path.read_text())
                if job["status"] in ACTIVE:
                    job.update(status="interrupted", error="Worker stopped; recover chat requests with the original ID, never resend", updated_at=time.time())
                    save(path, job)
        except BlockingIOError:
            pass
    return job


def public_job(job):
    # Snapshots omit both prompts and output. Results require an explicit get.
    return {**summary(job), "result": job.get("result")}


def occupied(path):
    if not path.exists():
        return False
    try:
        with lock(path, blocking=False):
            return False
    except BlockingIOError:
        return True


def status():
    jobs = []
    if ROOT.is_dir():
        paths = sorted(ROOT.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        for path in paths:
            if path.name.startswith("."):
                continue
            try:
                jobs.append(summary(get(path.stem)))
            except (OSError, ValueError, KeyError):
                continue
        # Keep the active owner visible even after many rejected submissions.
        jobs = [job for job in jobs if job["status"] in ACTIVE] + [job for job in jobs if job["status"] not in ACTIVE][:20]
    try:
        permissions = json.loads((ROOT / ".permissions.json").read_text())
    except (OSError, ValueError):
        permissions = None
    apps = {"codex": Path("/Applications/ChatGPT.app").is_dir(), "zcode": Path("/Applications/ZCode.app").is_dir()}
    if permissions and isinstance(permissions.get("apps"), dict):
        apps = {key: bool(permissions["apps"].get(key)) for key in apps}
    return {"version": 1, "installed": RUNNER.is_file() and (Path.home() / "Agent Script Runner.app").is_dir(),
            "apps": apps,
            "permissions": permissions, "jobs": jobs, "paused": (ROOT / ".paused").exists(),
            "desktop_busy": any(occupied(path) for path in [ROOT / ".desktop-worker.lock", ROOT / ".install.lock", chat_requests.GUI_LOCK, chat_requests.NATIVE_LOCK]),
            "capabilities": ["doctor", "permissions", "chat", "script", "get", "cancel", "coordinate", "diagnostics"]}


def coordinate(paused):
    if type(paused) is not bool:
        raise Failure("paused must be boolean")
    ROOT.mkdir(parents=True, mode=0o700, exist_ok=True)
    with lock(ROOT / ".admission.lock"):
        marker = ROOT / ".paused"
        if paused:
            fd = os.open(marker, os.O_CREAT | os.O_WRONLY, 0o600)
            os.close(fd)
        elif marker.exists():
            marker.unlink()
    return {"ok": True, "data": status()}


def diagnostics():
    state = status()
    # A shareable report deliberately excludes prompts, outputs and free-text errors.
    state["jobs"] = [{k: v for k, v in job.items() if k != "error"} for job in state["jobs"]]
    if state["permissions"]:
        state["permissions"] = {k: v for k, v in state["permissions"].items()
                                if k in {"accessibility", "automation", "automation_code", "console_session", "screen_locked", "checked_at", "apps"}}
    versions = {}
    for app in [Path.home() / "Agent Script Runner.app", Path("/Applications/ChatGPT.app"), Path("/Applications/ZCode.app")]:
        try:
            with (app / "Contents/Info.plist").open("rb") as stream:
                info = plistlib.load(stream)
            versions[app.name] = {k: info.get(k) for k in ["CFBundleIdentifier", "CFBundleShortVersionString", "CFBundleVersion"]}
        except (OSError, ValueError):
            versions[app.name] = None
    try:
        manifest = json.loads((SOURCE / "manifest.json").read_text())
    except (OSError, ValueError):
        manifest = None
    return {"ok": True, "report": {"generated_at": time.time(), "platform": platform.platform(),
            "python": platform.python_version(), "versions": versions, "build": manifest, "state": state}}


def submit(request):
    request = validate(request)
    path = job_path(request["request_id"])
    with lock(path.with_suffix(".submit")):
        if path.exists():
            job = get(request["request_id"])
            if job["request"] != request:
                raise Failure("Request ID already belongs to different content", 409)
            return {"ok": True, "reused": True, "job": public_job(job)}
        if occupied(ROOT / ".install.lock"):
            raise Failure("Toolkit installation in progress; nothing submitted", 409)
        if (ROOT / ".paused").exists():
            raise Failure("Desktop admission is paused; resume before submitting a new job", 409)
        job = {"id": request["request_id"], "operation": request["operation"], "request": request,
               "status": "queued", "created_at": time.time(), "updated_at": time.time(), "error": None, "result": None}
        # Persist before starting anything; an uncertain spawn is never replayed.
        save(path, job)
        try:
            subprocess.Popen([sys.executable, str(SOURCE / "desktop-automation"), "worker", job["id"]],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True, close_fds=True)
        except OSError as error:
            job.update(status="failed", error=str(error), updated_at=time.time())
            save(path, job)
        return {"ok": True, "reused": False, "job": public_job(job)}


def cancel(job_id):
    job = get(job_id)
    if job["status"] in ACTIVE:
        # Cooperative marker: never send a signal to a persisted/recycled PID.
        marker = job_path(job_id).with_suffix(".cancel")
        fd = os.open(marker, os.O_CREAT | os.O_WRONLY, 0o600)
        os.close(fd)
    return {"ok": True, "job": public_job(job)}


def command(request):
    op = request["operation"]
    if op == "doctor":
        return [str(RUNNER), "exec", str(SOURCE / "permissions")], None
    if op == "permissions":
        return [str(RUNNER), "authorize"], None
    if op == "script":
        return [str(RUNNER), request["mode"], request["path"], *request.get("arguments", [])], None
    argv = [str(SOURCE / (request["app"] + "-chat")), request["mode"]]
    if request["mode"] == "recover":
        argv.append(request["original_request_id"])
    elif request["mode"] != "new":
        argv.append(request["target"])
    argv += ["--timeout", str(request.get("timeout", 120))]
    if request["mode"] in {"new", "send"}:
        argv += ["--request-id", request["request_id"]]
    return argv, request.get("message")


def execute(argv, message, job, deadline):
    path = job_path(job["id"])
    with tempfile.TemporaryFile() as input_file, tempfile.TemporaryFile() as output_file, tempfile.TemporaryFile() as error_file:
        if message is not None:
            input_file.write(message.encode())
            input_file.seek(0)
        process = subprocess.Popen(argv, stdin=input_file, stdout=output_file, stderr=error_file, start_new_session=True,
                                   pass_fds=(chat_requests.GUI_LOCK_FD,) if chat_requests.GUI_LOCK_FD is not None else ())
        stopped = None
        try:
            while process.poll() is None:
                if path.with_suffix(".cancel").exists():
                    stopped = "cancelled"
                elif time.monotonic() >= deadline:
                    stopped = "timed_out"
                elif os.fstat(output_file.fileno()).st_size + os.fstat(error_file.fileno()).st_size > LIMIT:
                    stopped = "output_limit"
                if stopped:
                    os.killpg(process.pid, signal.SIGINT)
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                    break
                time.sleep(.1)
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
        if stopped:
            return {"ok": False, "status": stopped, "error": "Waiting stopped; this does not undo effects or cancel an App's model turn"}
        output_file.seek(0)
        raw = output_file.read(LIMIT + 1)
        if len(raw) > LIMIT:
            return {"ok": False, "status": "output_limit", "error": "Output exceeded 1 MiB"}
        try:
            result = json.loads(raw)
            if not isinstance(result, dict):
                raise ValueError("Expected object")
            return result
        except ValueError:
            error_file.seek(0)
            raise Failure("Invalid helper response: " + error_file.read(1000).decode(errors="replace"), 502)


def permission_result(result):
    if result.get("stdout"):
        result = json.loads(result["stdout"])
    if "system_events_automation" in result:
        result["automation"] = result.pop("system_events_automation")
    if not isinstance(result.get("accessibility"), bool) or "automation" not in result or result["automation"] not in [True, False, None]:
        raise Failure("Permission check did not return capability states", 502)
    result["checked_at"] = time.time()
    save(ROOT / ".permissions.json", result)
    return result


def worker(job_id):
    path = job_path(job_id)
    with lock(path.with_suffix(".work"), blocking=False):
        job = json.loads(path.read_text())
        if job["status"] != "queued":
            return
        try:
            with lock(ROOT / ".desktop-worker.lock", blocking=False), (nullcontext() if job["request"]["operation"] == "chat" else chat_requests.desktop()):
                request = validate(job["request"])
                with lock(ROOT / ".admission.lock"):
                    if (ROOT / ".paused").exists():
                        raise Failure("Desktop admission paused before dispatch; nothing sent", 409)
                    job.update(status="running", updated_at=time.time())
                    save(path, job)
                deadline = time.monotonic() + request.get("timeout", 120)
                if path.with_suffix(".cancel").exists():
                    job.update(status="cancelled")
                    return
                if request["operation"] == "permissions":
                    pane = "Privacy_Accessibility" if request["permission"] == "accessibility" else "Privacy_Automation"
                    subprocess.run(["/usr/bin/open", "x-apple.systempreferences:com.apple.preference.security?" + pane], check=True, timeout=5)
                result = execute(*command(request), job, deadline)
                if result.get("status") in {"cancelled", "timed_out", "output_limit"}:
                    job.update(status="cancelled" if result["status"] == "cancelled" else "failed", result=result, error=result.get("error"))
                    return
                if request["operation"] in {"doctor", "permissions"} and "accessibility" not in result and not result.get("stdout"):
                    raise Failure(result.get("error", "Permission helper unavailable"), 503)
                if request["operation"] in {"doctor", "permissions"}:
                    result = permission_result(result)
                if request["operation"] == "permissions":
                    job.update(status="waiting_user", result=result, updated_at=time.time())
                    save(path, job)
                    requested = execute([str(RUNNER), "run", str(SOURCE / "request-automation.applescript")], None, job, deadline)
                    # Granting consent can invalidate the in-flight AppleEvent (-609).
                    # The independent capability check below determines the final state.
                    if not requested.get("ok") and requested.get("apple_script_error") != -609:
                        job.update(status="cancelled" if requested.get("status") == "cancelled" else "needs_user", result=requested)
                        return
                    checked = execute([str(RUNNER), "exec", str(SOURCE / "permissions")], None, job, deadline)
                    if not checked.get("ok"):
                        job.update(status="cancelled" if checked.get("status") == "cancelled" else "needs_user", result=checked)
                        return
                    result = permission_result(checked)
                    while not (result["accessibility"] and result["automation"]):
                        job.update(status="waiting_user", result=result, updated_at=time.time())
                        save(path, job)
                        if path.with_suffix(".cancel").exists() or time.monotonic() >= deadline:
                            job.update(status="cancelled" if path.with_suffix(".cancel").exists() else "needs_user", result=result)
                            return
                        time.sleep(1)
                        checked = execute([str(RUNNER), "exec", str(SOURCE / "permissions")], None, job, deadline)
                        if not checked.get("ok"):
                            job.update(status="cancelled" if checked.get("status") == "cancelled" else "needs_user", result=checked)
                            return
                        result = permission_result(checked)
                job.update(result=result, status="completed" if result.get("ok") else "failed", error=result.get("error"))
                if result.get("status") == "cancelled":
                    job["status"] = "cancelled"
        except BlockingIOError:
            job.update(status="failed", error="Another desktop job is active; nothing dispatched")
        except Exception as error:
            job.update(status="failed", error=str(error))
        finally:
            job["updated_at"] = time.time()
            save(path, job)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["status", "submit", "get", "wait", "cancel", "worker", "coordinate", "diagnostics"])
    parser.add_argument("job_id", nargs="?")
    parser.add_argument("--timeout", type=int, default=120)
    args = parser.parse_args()
    try:
        if args.action == "status":
            result = {"ok": True, "data": status()}
        elif args.action == "diagnostics":
            result = diagnostics()
        elif args.action == "coordinate":
            request = json.loads(sys.stdin.read(1000))
            if not isinstance(request, dict) or set(request) != {"paused"}:
                raise Failure("Expected only paused")
            result = coordinate(request["paused"])
        elif args.action == "submit":
            raw = sys.stdin.read(300001)
            if len(raw) > 300000:
                raise Failure("Request too large")
            result = submit(json.loads(raw))
        elif args.action == "get":
            result = {"ok": True, "job": public_job(get(args.job_id))}
        elif args.action == "wait":
            deadline = time.monotonic() + max(1, min(args.timeout, 900))
            while True:
                job = get(args.job_id)
                if job["status"] not in ACTIVE or time.monotonic() >= deadline:
                    break
                time.sleep(.5)
            result = {"ok": True, "job": public_job(job)}
        elif args.action == "cancel":
            result = cancel(args.job_id)
        else:
            worker(args.job_id)
            return
    except (Failure, OSError, ValueError) as error:
        result = {"ok": False, "status": getattr(error, "status", 500), "error": str(error)}
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if result.get("ok") else 1)
