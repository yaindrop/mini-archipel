#!/usr/bin/python3
"""Export this node's operational state, encrypted for its operator."""

import hashlib
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import tarfile
import tempfile
import time
from pathlib import Path

os.umask(0o077)
h = Path.home()
dest = h / ".local/state/mini-archipel/backups"
dest.mkdir(parents=True, exist_ok=True, mode=0o700)
name = time.strftime("%Y%m%d-%H%M%S") + "-" + h.name + ".tar.gz.cms"
with tempfile.TemporaryDirectory(prefix=".export-", dir=dest) as work:
    w = Path(work)
    tree = w / "files"
    tree.mkdir(mode=0o700)
    paths = [
        h / ".config/mini-archipel",
        h / ".config/flowbit-ci-proxy",
        h / ".local/libexec/mini-archipel-agent",
        h / ".local/libexec/mini-archipel-console",
        h / ".local/libexec/mini-ci",
        h / ".local/libexec/mini-archipel",
        h / ".local/state/mini-ci/runner-policy.json",
        h / ".local/state/mini-ci/runner-operations.json",
        h / ".local/share/mini-archipel/disk-scan.json",
        h / ".colima/default/colima.yaml",
        h / ".docker/config.json",
        h / ".config/fanctl.conf",
    ]
    paths += list((h / "Library/LaunchAgents").glob("local.miniarchipel.*.plist"))
    paths += list((h / "Library/LaunchAgents").glob("actions.runner.*.plist"))
    paths += list((h / "Library/LaunchAgents").glob("com.flowbit.ci-proxy*.plist"))
    for runner in (h / "runners").iterdir():
        if runner.is_dir() and not runner.is_symlink():
            paths += [
                runner / n
                for n in [
                    ".runner",
                    ".credentials",
                    ".credentials_rsaparams",
                    ".env",
                    ".path",
                    ".service",
                ]
            ]
    missing = []
    for p in paths:
        if not p.exists():
            continue
        target = tree / p.relative_to(h)
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            if p.is_dir():
                shutil.copytree(
                    p,
                    target,
                    symlinks=True,
                    ignore=shutil.ignore_patterns("__pycache__"),
                )
            else:
                shutil.copy2(p, target)
        except PermissionError:
            missing.append(str(p.relative_to(h)))
    sock = Path("/var/run/mini-archipel/fan-control.sock")
    if sock.exists():
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(6)
            connection.connect(str(sock))
            connection.sendall(b'{"op":"read"}\n')
            chunks = []
            while True:
                chunk = connection.recv(65536)
                if not chunk:
                    break
                chunks.append(chunk)
            reply = json.loads(b"".join(chunks))
            assert reply["ok"] and reply["data"]["availability"] == "ready"
            recovery = tree / "restoration"
            recovery.mkdir(mode=0o700)
            (recovery / "fan-policy.json").write_text(
                json.dumps(reply["data"]["policy"], indent=2)
            )
    db = h / ".local/share/mini-archipel/console.db"
    if db.exists():
        target = tree / db.relative_to(h)
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with sqlite3.connect(db.as_uri() + "?mode=ro", uri=True, timeout=30) as src:
            with sqlite3.connect(target) as backup:
                src.backup(backup, pages=1024, sleep=0.05)
                assert backup.execute("PRAGMA quick_check").fetchone()[0] == "ok"
                assert (
                    backup.execute(
                        "SELECT count(*) FROM sqlite_master WHERE type='table'"
                    ).fetchone()[0]
                    > 0
                )
    manifest = {
        "node": h.name,
        "created_at": time.time(),
        "home": str(h),
        "unreadable": missing,
        "files": {
            str(p.relative_to(tree)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in tree.rglob("*")
            if p.is_file() and not p.is_symlink()
        },
    }
    (tree / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2)
    )
    archive = w / "state.tar.gz"
    with tarfile.open(archive, "w:gz", compresslevel=3) as tar:
        for p in tree.iterdir():
            tar.add(p, arcname=p.name)
    temporary = dest / (name + ".partial")
    try:
        subprocess.run(
            [
                "/usr/bin/openssl",
                "cms",
                "-encrypt",
                "-binary",
                "-aes256",
                "-in",
                str(archive),
                "-outform",
                "DER",
                "-out",
                str(temporary),
                str(h / ".config/mini-archipel/recovery.crt"),
            ],
            check=True,
            timeout=120,
        )
        temporary.chmod(0o600)
        os.replace(temporary, dest / name)
    finally:
        temporary.unlink(missing_ok=True)
for p in sorted(dest.glob("*.tar.gz.cms"))[:-14]:
    p.unlink()
p = dest / name
print(
    json.dumps(
        {
            "node": h.name,
            "path": str(p),
            "bytes": p.stat().st_size,
            "sha256": hashlib.sha256(p.read_bytes()).hexdigest(),
            "file_count": len(manifest["files"]),
            "unreadable": missing,
        }
    )
)
