#!/usr/bin/python3
"""Serialize Actions jobs across every repository on one macOS node."""

import contextlib
import fcntl
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

STATE = Path.home() / ".local/state/mini-archipel/ci"


@contextlib.contextmanager
def locked(state):
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state / "mutex").open("a+") as mutex:
        os.fchmod(mutex.fileno(), 0o600)
        deadline = time.monotonic() + 3
        while True:
            try:
                fcntl.flock(mutex, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError("Node runner policy is busy; retry shortly")
                time.sleep(0.05)
        yield


def save(path, value):
    encoded = json.dumps(value)
    if path.exists() and path.read_text() == encoded:
        return
    temp = path.with_name(path.name + ".tmp-" + str(os.getpid()))
    try:
        with temp.open("w") as file:
            temp.chmod(0o600)
            file.write(encoded)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def policy(state):
    path = state / "runner-policy.json"
    value = (
        json.loads(path.read_text())
        if path.exists()
        else {"enabled": False, "paused": {}}
    )
    if (
        not isinstance(value, dict)
        or set(value) != {"enabled", "paused"}
        or type(value["enabled"]) is not bool
        or not isinstance(value["paused"], dict)
    ):
        raise ValueError("Invalid runner policy; inspect node state")
    for directory, identity in value["paused"].items():
        if (
            not valid_directory(directory)
            or not isinstance(identity, dict)
            or set(identity) != {"pid", "started"}
            or type(identity["pid"]) is not int
            or identity["pid"] < 1
            or not isinstance(identity["started"], str)
        ):
            raise ValueError("Invalid paused runner identity; inspect node state")
    return value


def valid_directory(name):
    return (
        isinstance(name, str)
        and bool(name)
        and name not in (".", "..")
        and "/" not in name
        and "\\" not in name
    )


def process_table():
    output = subprocess.check_output(
        ["/bin/ps", "-axo", "pid=,uid=,stat=,lstart=,comm="],
        text=True,
        env={**os.environ, "LC_ALL": "C"},
    )
    result = {}
    for line in output.splitlines():
        fields = line.split(None, 8)
        if (
            len(fields) == 9
            and int(fields[1]) == os.getuid()
            and not fields[2].startswith("Z")
        ):
            result[int(fields[0])] = {
                "pid": int(fields[0]),
                "started": " ".join(fields[3:8]),
                "command": fields[8],
                "stopped": "T" in fields[2],
            }
    return result


def installations(home):
    base = home / "runners"
    result = {}
    if not base.is_dir():
        return result
    for directory in base.iterdir():
        if (
            not valid_directory(directory.name)
            or directory.is_symlink()
            or not directory.is_dir()
        ):
            continue
        path = directory / ".runner"
        if not path.is_file():
            continue
        registration = json.loads(path.read_text(encoding="utf-8-sig"))
        repo = (
            registration.get("gitHubUrl", "")
            .removeprefix("https://github.com/")
            .rstrip("/")
            .lower()
        )
        if (
            not registration.get("gitHubUrl", "").startswith("https://github.com/")
            or len(repo.split("/")) != 2
        ):
            raise ValueError("Invalid runner repository registration")
        result[directory.name] = repo
    return result


def hooks_ready(home, installs):
    hooks = home / ".local/libexec/mini-archipel/ci"
    for directory in installs:
        path = home / "runners" / directory / ".env"
        lines = path.read_text().splitlines() if path.is_file() else []
        for event, name in [
            ("STARTED", "job-started.sh"),
            ("COMPLETED", "job-completed.sh"),
        ]:
            if (
                f"ACTIONS_RUNNER_HOOK_JOB_{event}={hooks / name}" not in lines
                or not (hooks / name).is_file()
            ):
                return False
    return bool(installs)


def matched(process, identity, command):
    return (
        process is not None
        and process["started"] == identity["started"]
        and process["command"] == str(command)
    )


def reconcile(state, home, value):
    """Hold the node lease lock; only freeze idle Listeners, never a Worker."""
    installs = installations(home)
    table = process_table()
    owner_path = state / "owner.json"
    owner = json.loads(owner_path.read_text()) if owner_path.exists() else None
    active = None
    if isinstance(owner, dict) and type(owner.get("pid")) is int:
        process = table.get(owner["pid"])
        if process and process["started"] == owner.get("started"):
            active = next(
                (
                    directory
                    for directory in installs
                    if process["command"]
                    == str(home / "runners" / directory / "bin/Runner.Worker")
                ),
                None,
            )
    waiting = [
        directory
        for directory in installs
        if directory != active
        and any(
            p["command"] == str(home / "runners" / directory / "bin/Runner.Worker")
            for p in table.values()
        )
    ]
    # A write-ahead journal lets the Agent recover a crash between saving and SIGSTOP.
    for directory, identity in list(value["paused"].items()):
        command = home / "runners" / directory / "bin/Runner.Listener"
        if not matched(table.get(identity["pid"]), identity, command):
            del value["paused"][directory]
        elif (
            not value["enabled"]
            or not active
            or directory == active
            or directory in waiting
        ):
            os.kill(identity["pid"], signal.SIGCONT)
            del value["paused"][directory]
        elif not table[identity["pid"]]["stopped"]:
            os.kill(identity["pid"], signal.SIGSTOP)
    save(state / "runner-policy.json", value)
    if value["enabled"] and active:
        for directory in installs:
            if (
                directory == active
                or directory in waiting
                or directory in value["paused"]
            ):
                continue
            command = home / "runners" / directory / "bin/Runner.Listener"
            listener = next(
                (p for p in table.values() if p["command"] == str(command)), None
            )
            # Respect manually stopped services and processes we did not pause.
            if listener is None or listener["stopped"]:
                continue
            identity = {"pid": listener["pid"], "started": listener["started"]}
            value["paused"][directory] = identity
            save(state / "runner-policy.json", value)
            live = process_table()
            if matched(live.get(identity["pid"]), identity, command):
                os.kill(identity["pid"], signal.SIGSTOP)
            # A job assigned just before STOP is allowed to wait in its hook, with
            # its Listener running so GitHub cancellation can still be delivered.
            live = process_table()
            if any(
                p["command"] == str(home / "runners" / directory / "bin/Runner.Worker")
                for p in live.values()
            ):
                if matched(live.get(identity["pid"]), identity, command):
                    os.kill(identity["pid"], signal.SIGCONT)
                value["paused"].pop(directory, None)
                if directory not in waiting:
                    waiting.append(directory)
        save(state / "runner-policy.json", value)
    return {
        "available": hooks_ready(home, installs),
        "enabled": value["enabled"],
        "active_repo": installs.get(active),
        "paused": sorted(value["paused"]),
        "waiting": sorted(waiting) if value["enabled"] else [],
        "error": None,
    }


def coordination(enable=None, state=STATE, home=None):
    home = home or Path.home()
    with locked(state):
        value = policy(state)
        if enable is not None:
            if type(enable) is not bool:
                raise ValueError("enable must be a boolean")
            if enable and not hooks_ready(home, installations(home)):
                raise RuntimeError("Install the shared job hooks on every runner first")
            value["enabled"] = enable
            save(state / "runner-policy.json", value)
        return reconcile(state, home, value)


def service(request, state=STATE, home=None):
    home = home or Path.home()
    if (
        not isinstance(request, dict)
        or set(request) != {"repo", "runner", "enable"}
        or not valid_directory(request["runner"])
        or type(request["enable"]) is not bool
    ):
        raise ValueError("Invalid runner service command")
    with locked(state):
        installs = installations(home)
        directory = request["runner"]
        if installs.get(directory) != request["repo"]:
            raise ValueError("Registered repository changed; refresh before retrying")
        value = policy(state)
        status = reconcile(state, home, value)
        if any(
            p["command"] == str(home / "runners" / directory / "bin/Runner.Worker")
            for p in process_table().values()
        ):
            raise RuntimeError("Runner is running a job")
        if (
            request["enable"]
            and status["enabled"]
            and status["active_repo"]
            and installs[directory] != status["active_repo"]
        ):
            raise RuntimeError(
                "Another runner holds the node lease; wait for it to finish"
            )
        agents = home / "Library/LaunchAgents"
        registered = Path(
            (home / "runners" / directory / ".service").read_text().strip()
        )
        plist = registered if registered.is_absolute() else agents / registered
        if (
            plist.parent != agents
            or plist.suffix != ".plist"
            or not plist.stem.startswith("actions.runner.")
        ):
            raise ValueError("Invalid registered runner service")
        domain = f"gui/{os.getuid()}"
        target = f"{domain}/{plist.stem}"

        def launch(*args, check=True):
            return subprocess.run(
                ["/bin/launchctl", *args], capture_output=True, check=check, timeout=5
            )

        if request["enable"]:
            launch("enable", target)
            if launch("print", target, check=False).returncode != 0:
                launch("bootstrap", domain, str(plist))
        else:
            # bootout the service before thawing a paused Listener, so it cannot
            # accept a new job in the interval before launchd requests shutdown.
            launch("disable", target)
            if launch("print", target, check=False).returncode == 0:
                launch("bootout", target)
            identity = value["paused"].get(directory)
            command = home / "runners" / directory / "bin/Runner.Listener"
            if identity and matched(
                process_table().get(identity["pid"]), identity, command
            ):
                os.kill(identity["pid"], signal.SIGCONT)
            value["paused"].pop(directory, None)
            save(state / "runner-policy.json", value)


def process_stamp(pid):
    result = subprocess.run(
        ["/bin/ps", "-p", str(pid), "-o", "lstart="],
        text=True,
        capture_output=True,
        env={**os.environ, "LC_ALL": "C"},
    )
    return " ".join(result.stdout.split()) if result.returncode == 0 else None


def worker_identity():
    output = subprocess.check_output(["/bin/ps", "-axo", "pid=,ppid=,comm="], text=True)
    rows = {}
    for line in output.splitlines():
        fields = line.split(None, 2)
        if len(fields) == 3:
            rows[int(fields[0])] = (int(fields[1]), fields[2])
    pid = os.getppid()
    while pid in rows:
        parent, command = rows[pid]
        if Path(command).name == "Runner.Worker":
            stamp = process_stamp(pid)
            if not stamp:
                break
            return {
                "pid": pid,
                "started": stamp,
                "repo": os.environ.get("GITHUB_REPOSITORY", ""),
                "run": os.environ.get("GITHUB_RUN_ID", ""),
            }
        if parent == pid:
            break
        pid = parent
    raise RuntimeError("CI hooks must be called by a real Runner.Worker")


def is_owner(identity, state=STATE):
    with locked(state):
        path = state / "owner.json"
        owner = json.loads(path.read_text()) if path.exists() else None
        return isinstance(owner, dict) and all(
            owner.get(k) == identity[k] for k in ("pid", "started")
        )


def update(identity, acquire, state=STATE):
    with locked(state):
        path = state / "owner.json"
        owner = json.loads(path.read_text()) if path.exists() else None
        if owner is not None and (
            not isinstance(owner, dict)
            or not isinstance(owner.get("pid"), int)
            or owner["pid"] < 1
            or not isinstance(owner.get("started"), str)
            or not owner["started"]
        ):
            raise RuntimeError("Invalid node lease; inspect state before retrying")
        same = owner and all(owner.get(k) == identity[k] for k in ("pid", "started"))
        if not acquire:
            if same:
                path.unlink()
            if (state / "runner-policy.json").exists():
                reconcile(state, Path.home(), policy(state))
            return True
        if owner and not same and process_stamp(owner["pid"]) == owner["started"]:
            return False
        save(path, identity)
        if (state / "runner-policy.json").exists():
            reconcile(state, Path.home(), policy(state))
        return True


def acquire(identity, timeout=3600):
    deadline = time.monotonic() + timeout
    waiting = False
    while not update(identity, True):
        if not waiting:
            print(
                "mini-archipel/ci: waiting for the current node job to finish",
                flush=True,
            )
            waiting = True
        if time.monotonic() >= deadline:
            raise TimeoutError("Node is still busy; no second job was started")
        time.sleep(1)
    print("mini-archipel/ci: acquired node job lease", flush=True)


if __name__ == "__main__":
    os.umask(0o077)
    if sys.argv[1:] == ["state"]:
        print(json.dumps(coordination()))
    elif sys.argv[1:] == ["policy"]:
        request = json.load(sys.stdin)
        if (
            not isinstance(request, dict)
            or set(request) != {"enable"}
            or type(request["enable"]) is not bool
        ):
            raise ValueError("Invalid runner policy command")
        print(json.dumps(coordination(request["enable"])))
    elif sys.argv[1:] == ["service"]:
        service(json.load(sys.stdin))
        print(json.dumps({"ok": True}))
    elif sys.argv[1:] == ["start"]:
        acquire(worker_identity())
    elif sys.argv[1:] == ["complete"]:
        update(worker_identity(), False)
    elif sys.argv[1:] == ["owned"]:
        raise SystemExit(0 if is_owner(worker_identity()) else 1)
    else:
        raise SystemExit("Usage: ci-lease.py start|complete|owned|state|policy|service")
