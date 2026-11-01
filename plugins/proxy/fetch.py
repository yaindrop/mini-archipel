#!/usr/bin/env python3
"""Fetch the pinned official Xray archive, or verify an offline copy."""

import argparse
import hashlib
import json
import shutil
import tempfile
import urllib.request
import zipfile
from pathlib import Path

SOURCE = Path(__file__).resolve().parent
LOCK = json.loads((SOURCE / "assets.lock.json").read_text())


def verify_assets(directory):
    for name, digest in LOCK["files"].items():
        path = directory / name
        if (
            path.is_symlink()
            or not path.is_file()
            or hashlib.sha256(path.read_bytes()).hexdigest() != digest
        ):
            raise ValueError("Asset checksum mismatch: " + name)


def prepare(output, archive=None):
    if output.exists():
        verify_assets(output)
        return
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".mini-proxy-assets-", dir=output.parent) as temporary:
        temporary = Path(temporary)
        if archive is None:
            archive = temporary / "release.zip"
            with (
                urllib.request.urlopen(LOCK["url"], timeout=30) as response,
                archive.open("wb") as stream,
            ):
                total = 0
                while chunk := response.read(1024 * 1024):
                    total += len(chunk)
                    if total > 64 * 1024 * 1024:
                        raise ValueError("Archive exceeded size limit")
                    stream.write(chunk)
        if archive.stat().st_size > 64 * 1024 * 1024:
            raise ValueError("Archive exceeded size limit")
        if hashlib.sha256(archive.read_bytes()).hexdigest() != LOCK["archive_sha256"]:
            raise ValueError("Archive checksum mismatch")
        staged = temporary / "assets"
        staged.mkdir()
        with zipfile.ZipFile(archive) as bundle:
            for name in LOCK["files"]:
                member = bundle.getinfo(name)
                if member.file_size > 64 * 1024 * 1024:
                    raise ValueError("Archive member exceeded size limit")
                with bundle.open(member) as src, (staged / name).open("wb") as dst:
                    shutil.copyfileobj(src, dst)
        verify_assets(staged)
        (staged / "xray").chmod(0o700)
        staged.rename(output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--archive", type=Path, help="Offline archive; still checked against assets.lock.json"
    )
    parser.add_argument("--output", type=Path, default=SOURCE / ".cache/assets")
    args = parser.parse_args()
    try:
        prepare(args.output, args.archive)
    except (OSError, ValueError, zipfile.BadZipFile, KeyError) as error:
        parser.exit(1, str(error) + "\n")
    print(args.output)


if __name__ == "__main__":
    main()
