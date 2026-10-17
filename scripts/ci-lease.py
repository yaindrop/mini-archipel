#!/usr/bin/python3
"""Serialize Actions jobs across every repository on one macOS node."""

import fcntl
import json
import os
import subprocess
import sys
import time
from pathlib import Path

STATE = Path.home() / ".local/state/mini-ci"


def process_stamp(pid):
    result = subprocess.run(
        ["/bin/ps", "-p", str(pid), "-o", "lstart="],
        text=True,
        capture_output=True,
        env={**os.environ, "LC_ALL": "C"},
    )
    return result.stdout.strip() if result.returncode == 0 else None


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
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state / "mutex").open("a+") as mutex:
        fcntl.flock(mutex, fcntl.LOCK_EX)
        path = state / "owner.json"
        owner = json.loads(path.read_text()) if path.exists() else None
        return isinstance(owner, dict) and all(
            owner.get(k) == identity[k] for k in ("pid", "started")
        )


def update(identity, acquire, state=STATE):
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state / "mutex").open("a+") as mutex:
        fcntl.flock(mutex, fcntl.LOCK_EX)
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
            return True
        if owner and not same and process_stamp(owner["pid"]) == owner["started"]:
            return False
        temp = state / ("owner.tmp-" + str(os.getpid()))
        with temp.open("w") as file:
            json.dump(identity, file)
        temp.chmod(0o600)
        os.replace(temp, path)
        return True


def acquire(identity, timeout=3600):
    deadline = time.monotonic() + timeout
    waiting = False
    while not update(identity, True):
        if not waiting:
            print("mini-ci: waiting for the current node job to finish", flush=True)
            waiting = True
        if time.monotonic() >= deadline:
            raise TimeoutError("Node is still busy; no second job was started")
        time.sleep(1)
    print("mini-ci: acquired node job lease", flush=True)


if __name__ == "__main__":
    os.umask(0o077)
    identity = worker_identity()
    if sys.argv[1:] == ["start"]:
        acquire(identity)
    elif sys.argv[1:] == ["complete"]:
        update(identity, False)
    elif sys.argv[1:] == ["owned"]:
        raise SystemExit(0 if is_owner(identity) else 1)
    else:
        raise SystemExit("Usage: ci-lease.py start|complete|owned")
