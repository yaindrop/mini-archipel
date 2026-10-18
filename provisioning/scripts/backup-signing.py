#!/usr/bin/python3
"""Encrypt the persistent signing identity without plaintext archives."""

import json
import os
import subprocess
import tarfile
import time
from pathlib import Path


def backup(home, recipient, destination):
    paths = [
        home / ".local/share/mini-archipel/signing",
        home / "Library/Keychains/mini-archipel-signing.keychain-db",
    ]
    if not all(path.exists() and not path.is_symlink() for path in paths):
        raise RuntimeError("Persistent signing material is missing")
    for name in ("identity.pem", "identity-key.pem", "keychain-password"):
        path = paths[0] / name
        if not path.is_file() or path.is_symlink():
            raise RuntimeError("Persistent signing recovery material is missing")
    for path in paths:
        if path.stat().st_uid != os.getuid():
            raise RuntimeError("Signing material must belong to the current user")
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    destination.chmod(0o700)
    name = (
        time.strftime("%Y%m%d-%H%M%S")
        + f"-{time.time_ns() % 1_000_000_000:09d}-signing.tar.gz.cms"
    )
    target = destination / name
    partial = target.with_suffix(".partial")
    process = None
    try:
        fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as encrypted:
            process = subprocess.Popen(
                [
                    "/usr/bin/openssl",
                    "cms",
                    "-encrypt",
                    "-binary",
                    "-aes256",
                    "-outform",
                    "DER",
                    str(recipient),
                ],
                stdin=subprocess.PIPE,
                stdout=encrypted,
                stderr=subprocess.PIPE,
            )
            with tarfile.open(fileobj=process.stdin, mode="w|gz") as archive:
                for path in paths:
                    archive.add(path, arcname=str(path.relative_to(home)))
            process.stdin.close()
            process.stdin = None
            process.communicate(timeout=30)
            if process.returncode:
                raise RuntimeError("Signing backup encryption failed")
            encrypted.flush()
            os.fsync(encrypted.fileno())
        os.replace(partial, target)
    finally:
        if process is not None and process.poll() is None:
            process.kill()
            process.wait()
        partial.unlink(missing_ok=True)
    for old in sorted(destination.glob("*-signing.tar.gz.cms"))[:-14]:
        old.unlink()
    return target


if __name__ == "__main__":
    os.umask(0o077)
    user_home = Path.home()
    output = backup(
        user_home,
        user_home / ".config/mini-ops/recovery.crt",
        user_home / ".local/share/mini-ops/backups/signing",
    )
    print(json.dumps({"path": str(output), "encrypted": True}))
