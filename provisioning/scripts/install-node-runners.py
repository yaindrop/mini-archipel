#!/usr/bin/python3
"""Install repo-isolated Actions runners on one node; never interrupt a Worker."""

import hashlib
import json
import os
import plistlib
import shutil
import subprocess
import sys
import time
from pathlib import Path

HOME = Path.home()
ROOT = HOME / "github-runners"
DEPLOY = Path(__file__).resolve().parent
PROFILE = json.loads(Path(sys.argv[1]).read_text())
TOKEN_PATH = Path(sys.argv[2])
ARCHIVE = Path(sys.argv[3])
LOG = DEPLOY / "install.log"
os.umask(0o077)


def workers():
    out = subprocess.check_output(["/bin/ps", "-axo", "comm="], text=True)
    return [
        row for row in out.splitlines() if Path(row.strip()).name == "Runner.Worker"
    ]


def run(args, cwd=None, env=None):
    result = subprocess.run(
        [str(a) for a in args],
        cwd=cwd,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    with LOG.open("a") as log:
        log.write(result.stdout)
    LOG.chmod(0o600)
    if result.returncode:
        raise RuntimeError(
            "Operation failed: " + str(args[0]) + "; see private install.log"
        )
    return result.stdout


def stopped(label):
    return (
        subprocess.run(
            ["/bin/launchctl", "print", "gui/%s/%s" % (os.getuid(), label)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ).returncode
        != 0
    )


def stop(label):
    if workers():
        raise RuntimeError(
            "A Worker started; leave services unchanged and retry when idle"
        )
    subprocess.run(
        ["/bin/launchctl", "bootout", "gui/%s/%s" % (os.getuid(), label)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    until = time.monotonic() + 40
    while not stopped(label):
        if time.monotonic() > until:
            raise RuntimeError("Runner service has not stopped; no process was killed")
        time.sleep(0.2)


def main():
    if workers():
        print(json.dumps({"status": "busy", "node": PROFILE["node"]}))
        return 75
    if hashlib.sha256(ARCHIVE.read_bytes()).hexdigest() != PROFILE["sha256"]:
        raise RuntimeError("Runner archive checksum mismatch")
    if TOKEN_PATH.stat().st_mode & 0o777 != 0o600:
        raise RuntimeError("Registration tokens must be private")
    tokens = json.loads(TOKEN_PATH.read_text())
    source = ROOT / "flowbit"
    path = (source / ".path").read_text().strip()
    allowed = {
        "LANG",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "no_proxy",
        "NO_PROXY",
        "ELECTRON_GET_USE_PROXY",
        "VITE_MKCERT_ENABLED",
        "COREPACK_DEFAULT_TO_LATEST",
        "COREPACK_ENABLE_AUTO_PIN",
        "COREPACK_ENABLE_DOWNLOAD_PROMPT",
        "HOMEBREW_NO_ANALYTICS",
    }
    common = dict(
        line.split("=", 1)
        for line in (source / ".env").read_text().splitlines()
        if "=" in line and line.split("=", 1)[0] in allowed
    )
    common.update(
        LANG="en_US.UTF-8",
        HOMEBREW_NO_ANALYTICS="1",
        ELECTRON_GET_USE_PROXY="1",
        VITE_MKCERT_ENABLED="0",
        COREPACK_DEFAULT_TO_LATEST="0",
        COREPACK_ENABLE_AUTO_PIN="0",
        COREPACK_ENABLE_DOWNLOAD_PROMPT="0",
    )
    hooks = HOME / ".local/libexec/mini-ci"
    hooks.mkdir(parents=True, exist_ok=True)
    for name in [
        "ci-lease.py",
        "ci-housekeeping.py",
        "job-started.sh",
        "job-completed.sh",
    ]:
        shutil.copy2(DEPLOY / name, hooks / name)
        (hooks / name).chmod(0o755)
    common["ACTIONS_RUNNER_HOOK_JOB_STARTED"] = str(hooks / "job-started.sh")
    common["ACTIONS_RUNNER_HOOK_JOB_COMPLETED"] = str(hooks / "job-completed.sh")
    environment = {**os.environ, **common, "PATH": path}
    backup = (
        HOME
        / ".local/share/mini-ci/backups"
        / time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    )
    backup.mkdir(parents=True)
    rows = []
    for repo in PROFILE["repositories"]:
        directory = ROOT / repo
        if (directory / ".runner").exists():
            registration = json.loads(
                (directory / ".runner").read_text(encoding="utf-8-sig")
            )
            assert (
                registration["gitHubUrl"].rstrip("/").lower()
                == "https://github.com/" + PROFILE["owner"] + "/" + repo
            )
            assert registration["agentName"] == repo + "-" + PROFILE["node"]
            label = Path((directory / ".service").read_text().strip()).stem
            for name in [".env", ".path"]:
                shutil.copy2(directory / name, backup / (repo + name))
            stop(label)
        else:
            assert not directory.exists(), (
                "Unregistered installation directory exists; inspect it first"
            )
            directory.mkdir(parents=True)
            run(["/usr/bin/tar", "-xzf", ARCHIVE, "-C", directory])
            labels = ["ci", PROFILE["kind"], "node-" + PROFILE["node"]]
            if PROFILE["kind"] == "physical":
                labels.append("container")
            run(
                [
                    "./config.sh",
                    "--unattended",
                    "--url",
                    "https://github.com/" + PROFILE["owner"] + "/" + repo,
                    "--token",
                    tokens[repo],
                    "--name",
                    repo + "-" + PROFILE["node"],
                    "--labels",
                    ",".join(labels),
                    "--work",
                    "_work",
                ],
                cwd=directory,
                env=environment,
            )
            label = None
        (directory / ".env").write_text(
            "".join(k + "=" + v + "\n" for k, v in sorted(common.items()))
        )
        (directory / ".path").write_text(path)
        for name in [
            ".env",
            ".path",
            ".runner",
            ".credentials",
            ".credentials_rsaparams",
            ".service",
        ]:
            if (directory / name).exists():
                (directory / name).chmod(0o600)
        if label is None:
            run(["./svc.sh", "install"], cwd=directory, env=environment)
            label = Path((directory / ".service").read_text().strip()).stem
            stop(label)
        plist = HOME / "Library/LaunchAgents" / (label + ".plist")
        data = plistlib.loads(plist.read_bytes())
        shutil.copy2(plist, backup / (repo + ".plist"))
        data.update(RunAtLoad=True, KeepAlive=True, ThrottleInterval=10, ExitTimeOut=30)
        plist.write_bytes(plistlib.dumps(data))
        run(["/bin/launchctl", "enable", "gui/%s/%s" % (os.getuid(), label)])
        run(["/bin/launchctl", "bootstrap", "gui/%s" % os.getuid(), plist])
        (directory / ".service").chmod(0o600)
        rows.append({"repo": repo, "label": label, "directory": str(directory)})
    TOKEN_PATH.unlink()
    print(json.dumps({"status": "ready", "node": PROFILE["node"], "runners": rows}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
