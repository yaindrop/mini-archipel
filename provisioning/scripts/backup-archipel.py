#!/usr/bin/python3
"""Daily encrypted operational backups; no CI dispatch or service changes."""

import fcntl
import hashlib
import json
import os
import subprocess
import tarfile
import tempfile
import time
from pathlib import Path

os.umask(0o077)
h = Path.home()
dest = h / ".local/share/mini-archipel/backups"
dest.mkdir(parents=True, exist_ok=True, mode=0o700)
with (dest / ".lock").open("a") as lock:
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit("another backup is running")
    results = []
    for node in ["yd-mini", "yd-mini-2", "yd-mbp-tart", "yd-mbp-tart-2"]:
        try:
            out = subprocess.check_output(
                [
                    "ssh",
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    "ConnectTimeout=15",
                    node,
                    "/usr/bin/python3 .local/libexec/mini-archipel/export-backup.py",
                ],
                text=True,
                timeout=600,
            )
            info = json.loads(out)
            assert info["node"] == node
            name = Path(info["path"]).name
            assert name.endswith("-" + node + ".tar.gz.cms") and "/" not in name
            folder = dest / node
            folder.mkdir(exist_ok=True, mode=0o700)
            partial = folder / (name + ".partial")
            try:
                subprocess.run(
                    [
                        "scp",
                        "-q",
                        "-o",
                        "BatchMode=yes",
                        "-o",
                        "ConnectTimeout=15",
                        node + ":" + info["path"],
                        str(partial),
                    ],
                    check=True,
                    timeout=180,
                )
                assert (
                    hashlib.sha256(partial.read_bytes()).hexdigest() == info["sha256"]
                )
                p = folder / name
                os.replace(partial, p)
            finally:
                partial.unlink(missing_ok=True)
            remote = ".local/state/mini-archipel/archipel-backups/" + node
            subprocess.run(
                [
                    "ssh",
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    "ConnectTimeout=15",
                    "yd-mini-2",
                    "umask 077; mkdir -p " + remote,
                ],
                check=True,
                timeout=30,
            )
            subprocess.run(
                [
                    "scp",
                    "-q",
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    "ConnectTimeout=15",
                    str(p),
                    "yd-mini-2:" + remote + "/" + name,
                ],
                check=True,
                timeout=180,
            )
            prune = (
                "from pathlib import Path; "
                "p=Path.home()/'.local/state/mini-archipel/archipel-backups'/"
                + repr(node)
                + "; [x.unlink() for x in sorted(p.glob('*.tar.gz.cms'))[:-14]]"
            )
            subprocess.run(
                [
                    "ssh",
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    "ConnectTimeout=15",
                    "yd-mini-2",
                    "/usr/bin/python3 -",
                ],
                input=prune,
                text=True,
                check=True,
                timeout=30,
            )
            for old in sorted(folder.glob("*.tar.gz.cms"))[:-14]:
                old.unlink()
            results.append({"ok": True, **info})
        except Exception as e:
            results.append(
                {
                    "node": node,
                    "ok": False,
                    "error": type(e).__name__ + ": " + str(e)[:300],
                }
            )
    host_backup = {"ok": False}
    try:
        folder = dest / "host"
        folder.mkdir(exist_ok=True, mode=0o700)
        name = time.strftime("%Y%m%d-%H%M%S") + "-host-ops.tar.gz.cms"
        signing_info = json.loads(
            subprocess.check_output(
                [
                    "/usr/bin/python3",
                    str(h / ".local/libexec/mini-archipel/backup-signing.py"),
                ],
                text=True,
                timeout=30,
            )
        )
        paths = [
            h / ".local/libexec/mini-archipel",
            h / ".config/mini-archipel/host.json",
            h / ".config/mini-archipel/vm-known-hosts",
            h / ".config/mini-archipel/recovery.crt",
        ]
        paths += [Path(signing_info["path"])]
        paths += list((h / "Library/LaunchAgents").glob("local.miniarchipel.*.plist"))
        paths += [
            h / ".tart/vms" / n / "config.json"
            for n in ["yd-mbp-tart", "yd-mbp-tart-2"]
        ]
        with tempfile.TemporaryDirectory(prefix=".host-", dir=dest) as work:
            archive = Path(work) / "host.tar.gz"
            with tarfile.open(archive, "w:gz") as tar:
                for path in paths:
                    if path.exists():
                        tar.add(path, arcname=str(path.relative_to(h)))
            partial = folder / (name + ".partial")
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
                    str(partial),
                    str(h / ".config/mini-archipel/recovery.crt"),
                ],
                check=True,
                timeout=30,
            )
            os.replace(partial, folder / name)
        remote = ".local/state/mini-archipel/archipel-backups/host"
        subprocess.run(
            [
                "ssh",
                "-o",
                "BatchMode=yes",
                "yd-mini-2",
                "umask 077; mkdir -p " + remote,
            ],
            check=True,
            timeout=30,
        )
        subprocess.run(
            [
                "scp",
                "-q",
                "-o",
                "BatchMode=yes",
                str(folder / name),
                "yd-mini-2:" + remote + "/" + name,
            ],
            check=True,
            timeout=30,
        )
        for old in sorted(folder.glob("*.tar.gz.cms"))[:-14]:
            old.unlink()
        prune = (
            "from pathlib import Path; "
            "p=Path.home()/'.local/state/mini-archipel/archipel-backups/host'; "
            "[x.unlink() for x in sorted(p.glob('*.tar.gz.cms'))[:-14]]"
        )
        subprocess.run(
            ["ssh", "-o", "BatchMode=yes", "yd-mini-2", "/usr/bin/python3 -"],
            input=prune,
            text=True,
            check=True,
            timeout=30,
        )
        host_backup = {
            "ok": True,
            "name": name,
            "sha256": hashlib.sha256((folder / name).read_bytes()).hexdigest(),
        }
    except Exception as e:
        host_backup["error"] = str(e)[:300]
    result = {"at": time.time(), "nodes": results, "host": host_backup}
    temporary = dest / "latest.json.tmp"
    temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    os.replace(temporary, dest / "latest.json")
    print(json.dumps(result, ensure_ascii=False), flush=True)
    if not host_backup["ok"] or not all(
        x["ok"] and not x["unreadable"] for x in results
    ):
        raise SystemExit(1)
