#!/usr/bin/python3
"""Shared post-job housekeeping: no daemon, no source deletion."""

import json
import os
import pathlib
import shutil
import signal
import subprocess
import time

H = pathlib.Path.home()
W = (
    pathlib.Path(os.environ["GITHUB_WORKSPACE"])
    if os.environ.get("GITHUB_WORKSPACE")
    else None
)
S = H / ".local/state/mini-archipel/ci/maintenance"
os.environ.update(
    COREPACK_DEFAULT_TO_LATEST="0",
    COREPACK_ENABLE_AUTO_PIN="0",
    COREPACK_ENABLE_DOWNLOAD_PROMPT="0",
    UV_LOCK_TIMEOUT="10",
)
lock = S / "lock"


def emit(action, **kw):
    S.mkdir(parents=True, exist_ok=True, mode=0o700)
    record = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "repo": os.environ.get("GITHUB_REPOSITORY", ""),
        "run": os.environ.get("GITHUB_RUN_ID", ""),
        "action": action,
        **kw,
    }
    p = S / "history.jsonl"
    if p.exists() and p.stat().st_size > 1024 * 1024:
        p.replace(S / "history.previous.jsonl")
    with p.open("a") as f:
        f.write(json.dumps(record) + "\n")
    print("mini-archipel/ci housekeeping: " + action, flush=True)


def run(args, timeout=30, cwd=None):
    return subprocess.run(
        [str(x) for x in args],
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
    )


def du(p):
    z = run(["du", "-sk", p], 30)
    return int(z.stdout.split()[0]) * 1024 if z.stdout.split() else 0


def deadline(signum, frame):
    raise TimeoutError("Housekeeping reached 90 second limit")


def safe_target(path, checkout):
    if (
        path.is_symlink()
        or not path.is_dir()
        or not path.resolve().is_relative_to(checkout.resolve())
    ):
        return False
    rel = str(path.relative_to(checkout))
    return (
        run(["git", "-C", checkout, "check-ignore", "-q", rel]).returncode == 0
        and not run(["git", "-C", checkout, "ls-files", "--", rel]).stdout.strip()
    )


def main():
    if W is None or not W.is_dir():
        return
    runner = H / "runners" / W.resolve().relative_to(H / "runners").parts[0]
    if not (runner / ".runner").is_file():
        raise ValueError("Workspace is not inside a registered runner")
    if run(
        ["/usr/bin/python3", H / ".local/libexec/mini-archipel/ci/ci-lease.py", "owned"]
    ).returncode:
        emit("skipped_without_node_lease")
        return
    S.mkdir(parents=True, exist_ok=True, mode=0o700)
    rows = {}
    for line in run(["ps", "-axo", "pid=,ppid=,comm="]).stdout.splitlines():
        fields = line.strip().split(None, 2)
        if len(fields) == 3:
            rows[int(fields[0])] = (int(fields[1]), fields[2])
    ancestor = os.getppid()
    from_worker = False
    while ancestor in rows:
        parent, command = rows[ancestor]
        if command.endswith("/Runner.Worker"):
            from_worker = True
            break
        if parent == ancestor:
            break
        ancestor = parent
    if not from_worker and any(
        command.endswith("/Runner.Worker") for parent, command in rows.values()
    ):
        emit("skipped_active_job")
        return
    try:
        lock.mkdir()
    except FileExistsError:
        if time.time() - lock.stat().st_mtime < 3600:
            return
        lock.rmdir()
        lock.mkdir()
    signal.signal(signal.SIGALRM, deadline)
    signal.alarm(90)
    try:
        # Keep open/newest logs; bound the rest to 256 MiB / 14 days.
        diag = runner / "_diag"
        logs = sorted(diag.glob("*.log"), key=lambda p: p.stat().st_mtime, reverse=True)
        opened = run(["lsof", "-n", "-a", "-u", H.name, "+d", str(diag), "-F", "n"], 15)
        open_paths = {
            line[1:]
            for line in opened.stdout.splitlines()
            if line.startswith("n" + str(diag) + "/")
        }
        total = sum(p.stat().st_size for p in logs)
        removed = 0
        for p in reversed(logs[5:]):
            if str(p) in open_paths:
                continue
            size = p.stat().st_size
            if time.time() - p.stat().st_mtime > 14 * 86400 or total > 256 * 1024**2:
                p.unlink()
                removed += size
                total -= size
        emit("logs_trimmed", removed_bytes=removed, remaining_bytes=total)
        # Prefer weekly pruning; retain needed dependencies and current browsers.
        stamp = S / "package-prune.timestamp"
        if not stamp.exists() or time.time() - stamp.stat().st_mtime > 7 * 86400:
            for key in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"):
                os.environ[key] = "http://127.0.0.1:10808"
            for key in ("all_proxy", "ALL_PROXY"):
                os.environ[key] = "socks5://127.0.0.1:10808"
            ok = True
            for name, args in [
                ("pnpm_store_prune", ["pnpm", "store", "prune"]),
                ("uv_cache_prune", ["/opt/homebrew/bin/uv", "cache", "prune"]),
            ]:
                z = run(args, 35, W)
                ok = ok and z.returncode == 0
                emit(
                    name, returncode=z.returncode, summary=(z.stdout + z.stderr)[-300:]
                )
            if ok:
                stamp.touch()
        # Trim cold targets first; reclaim hot targets only below the 40 GB reserve.
        # One budget across all registered repository workspaces on this node.
        targets = []
        for install in (H / "runners").iterdir():
            if not (install / ".runner").is_file() or install.is_symlink():
                continue
            for checkout in (install / "_work").glob("*/*"):
                if (
                    checkout.is_symlink()
                    or not checkout.resolve().is_relative_to(install.resolve())
                    or not (checkout / ".git").exists()
                ):
                    continue
                for p, dirs, files in os.walk(checkout):
                    for n in ("target", "node_modules", ".venv", ".git", "__pycache__"):
                        if n in dirs:
                            if n == "target":
                                q = pathlib.Path(p) / n
                                if safe_target(q, checkout):
                                    size = du(q)
                                    recent = max(
                                        [q.stat().st_mtime]
                                        + [
                                            f.stat().st_mtime
                                            for fp in q.rglob(".fingerprint")
                                            if fp.is_dir()
                                            for f in fp.rglob("*")
                                            if f.is_file() and not f.is_symlink()
                                        ]
                                    )
                                    targets.append([recent, size, q])
                            dirs.remove(n)
                    dirs[:] = [
                        d for d in dirs if not (pathlib.Path(p) / d).is_symlink()
                    ]
        total = sum(x[1] for x in targets)
        for age, size, p in sorted(targets):
            low = shutil.disk_usage(H).free < 40_000_000_000
            if total <= 32 * 1024**3 and not low:
                break
            if not low and time.time() - age < 7 * 86400:
                continue
            shutil.rmtree(p)
            total -= size
            emit("generated_target_trimmed", path=str(p), du_bytes=size)
        emit(
            "complete", target_du_bytes=total, ssd_free_bytes=shutil.disk_usage(H).free
        )
    finally:
        signal.alarm(0)
        lock.rmdir()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        # Preserve diagnostics without failing an otherwise successful job.
        try:
            emit("warning", detail=type(e).__name__ + ": " + str(e)[:300])
        except Exception:
            pass
        print(
            "::warning::mini-archipel/ci maintenance incomplete; "
            "see node maintenance history.",
            flush=True,
        )
