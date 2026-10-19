#!/usr/bin/python3
"""Explicit CI lifecycle shared by the archipelago repositories.

Request, pin the dispatch commit, confirm the node lease, prepare, accept the
live environment, then run the repository's own check command.

ponytail: the node keeps one latest report per repository; older runs stay in
the Actions artifact. Per-run history files can replace that if operators need
them on disk.
"""

import json
import os
import platform
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

SCHEMA = 1
CONCLUSIONS = {
    "passed",
    "environment",
    "check",
    "infrastructure",
    "interrupted",
    "incomplete",
}
DOC_KEYS = (
    "services",
    "graphics",
    "network",
    "credentials",
    "data",
    "permissions",
)


class Stop(Exception):
    def __init__(self, conclusion, reason):
        super().__init__(reason)
        self.conclusion = conclusion
        self.reason = reason


def atomic_write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + ".tmp-" + str(os.getpid()))
    try:
        with temporary.open("w") as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def repo_dir_name(repo):
    leaf = repo.rsplit("/", 1)[-1]
    if not re.fullmatch(r"[A-Za-z0-9._-]+", leaf or ""):
        raise Stop("infrastructure", f"invalid repository name {repo}")
    return leaf


def validate_requirements(data):
    if not isinstance(data, dict) or data.get("schema") != SCHEMA:
        raise Stop("infrastructure", "ci/requirements.json schema must be 1")
    capabilities = data.get("capabilities")
    if not isinstance(capabilities, list) or not all(
        isinstance(item, str) and item for item in capabilities
    ):
        raise Stop("infrastructure", "capabilities must be a list of labels")
    for key in DOC_KEYS:
        value = data.get(key, [])
        if not isinstance(value, list) or not all(
            isinstance(item, str) for item in value
        ):
            raise Stop("infrastructure", f"{key} must be a list of strings")
    stages = data.get("stages")
    if not isinstance(stages, list) or not stages:
        raise Stop("infrastructure", "stages must be a non-empty list")
    for stage in stages:
        if not isinstance(stage, dict) or not re.fullmatch(
            r"[A-Za-z0-9._-]+", str(stage.get("id", ""))
        ):
            raise Stop("infrastructure", "each stage needs a stable id")
        for key in ("prepare", "check"):
            if not isinstance(stage.get(key), str) or not stage[key].strip():
                raise Stop("infrastructure", f"stage {stage.get('id')} needs {key}")
        if "cleanup" in stage and (
            not isinstance(stage["cleanup"], str) or not stage["cleanup"].strip()
        ):
            raise Stop(
                "infrastructure", f"stage {stage['id']} cleanup must be a command"
            )
        if "require" in stage and not isinstance(stage["require"], list):
            raise Stop("infrastructure", f"stage {stage['id']} require must be a list")
        venv = stage.get("venv")
        if venv is not None and (
            not isinstance(venv, str)
            or Path(venv).is_absolute()
            or ".." in Path(venv).parts
        ):
            raise Stop(
                "infrastructure", f"stage {stage['id']} venv must stay in the workspace"
            )
        toolchain = stage.get("toolchain", {})
        if not isinstance(toolchain, dict) or not all(
            isinstance(key, str) and isinstance(value, str)
            for key, value in toolchain.items()
        ):
            raise Stop(
                "infrastructure",
                f"stage {stage['id']} toolchain must map tool to version",
            )
    return data


def load_requirements(path):
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise Stop("infrastructure", f"cannot read requirements: {exc}") from exc
    return validate_requirements(data)


def request_allowed(env):
    if env.get("MINI_CI_REQUEST") != "run-ci":
        return False, "missing explicit run-ci request"
    event = env.get("GITHUB_EVENT_NAME", "")
    if not event:
        return True, "local"
    if event != "pull_request":
        return False, f"event {event} is not an explicit run-ci request"
    raw = env.get("GITHUB_EVENT_PATH", "")
    if not raw:
        return False, "pull_request event payload is missing"
    try:
        payload = json.loads(Path(raw).read_text())
    except (OSError, json.JSONDecodeError) as exc:
        return False, f"unreadable event payload: {exc}"
    if payload.get("action") != "labeled":
        return False, "pull_request action is not labeled"
    label = (payload.get("label") or {}).get("name")
    if label != "run-ci":
        return False, f"label {label!r} is not run-ci"
    try:
        head = payload["pull_request"]["head"]["repo"]["full_name"]
        base = payload["repository"]["full_name"]
    except (KeyError, TypeError):
        return False, "event payload has no repository identity"
    if head != base:
        return False, "fork pull requests are not accepted"
    return True, "labeled"


def load_event(env):
    raw = env.get("GITHUB_EVENT_PATH", "")
    if not raw:
        return None
    try:
        return json.loads(Path(raw).read_text())
    except (OSError, json.JSONDecodeError):
        return None


def host_facts():
    version = platform.platform()
    try:
        version = subprocess.check_output(
            ["/usr/bin/sw_vers", "-productVersion"], text=True
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        pass
    return {
        "system": platform.system(),
        "machine": platform.machine(),
        "version": version,
    }


def host_gate(capabilities, facts, runs_on):
    reasons = []
    if "macOS" in capabilities and facts.get("system") != "Darwin":
        reasons.append(f"host system is {facts.get('system')}, required macOS")
    if "ARM64" in capabilities and facts.get("machine") not in {"arm64", "aarch64"}:
        reasons.append(f"host machine is {facts.get('machine')}, required ARM64")
    if runs_on:
        missing = [label for label in capabilities if label not in runs_on]
        if missing:
            reasons.append("scheduled labels omit " + ", ".join(missing))
    return reasons


def version_ok(output, expected):
    return (
        re.search(
            rf"(?:^|[^0-9])v?{re.escape(expected)}(?:[^0-9]|$)",
            output.strip(),
        )
        is not None
    )


def toolchain_roots(env):
    raw = env.get("MINI_CI_TOOLCHAIN_ROOT", "")
    if raw:
        return [Path(part) for part in raw.split(os.pathsep) if part]
    home = Path(env.get("HOME", str(Path.home())))
    return [
        home / ".local/share/mini-ci/toolchains",
        home / ".local/ci-pinned",
    ]


def run_shell(command, env, cwd):
    completed = subprocess.run(
        ["/bin/bash", "-c", command],
        cwd=cwd,
        env=env,
        text=True,
        capture_output=True,
    )
    return completed.returncode, completed.stdout, completed.stderr


def probe(argv, env, cwd):
    try:
        completed = subprocess.run(
            argv,
            cwd=cwd,
            env=env,
            text=True,
            capture_output=True,
        )
    except FileNotFoundError:
        name = argv[0] if argv else "command"
        return 127, f"{name} is not on PATH"
    except OSError as exc:
        name = argv[0] if argv else "command"
        return 127, f"{name}: {exc}"
    return completed.returncode, (completed.stdout or "") + (completed.stderr or "")


def host_path_prefixes(env):
    home = Path(env.get("HOME", str(Path.home())))
    prefixes = [
        home / ".local" / "ci-pinned" / "bin",
        home / ".local" / "share" / "mini-ci" / "bin",
        Path("/opt/homebrew/bin"),
        Path("/opt/homebrew/sbin"),
        home / ".local" / "bin",
        home / ".cargo" / "bin",
    ]
    return [str(path) for path in prefixes if path.is_dir()]


def with_host_path(env):
    if env.get("MINI_CI_HOST_PATH") == "0":
        return env
    prefixes = host_path_prefixes(env)
    if not prefixes:
        return env
    updated = dict(env)
    parts = [part for part in updated.get("PATH", "").split(os.pathsep) if part]
    for prefix in reversed(prefixes):
        if prefix not in parts:
            parts.insert(0, prefix)
    updated["PATH"] = os.pathsep.join(parts)
    return updated


def tool_candidates(kind, version, env):
    filename = kind
    found = []
    for root in toolchain_roots(env):
        found.append(root / kind / version / "bin" / filename)
        series = root / kind
        if series.is_dir():
            for child in sorted(series.iterdir(), reverse=True):
                if child.name != version and version_ok(child.name, version):
                    found.append(child / "bin" / filename)
        found.append(root / "bin" / filename)
    cache = env.get("RUNNER_TOOL_CACHE", "")
    if cache and kind == "node":
        for arch in ("arm64", "x64"):
            found.append(Path(cache) / "node" / version / arch / "bin" / filename)
            cache_root = Path(cache) / "node"
            if cache_root.is_dir():
                for child in sorted(cache_root.iterdir(), reverse=True):
                    if child.name != version and version_ok(child.name, version):
                        found.append(child / arch / "bin" / filename)
    return found


def shim_bindir(env, kind, version):
    root = Path(env.get("RUNNER_TEMP") or "/tmp") / "mini-ci-shims"
    bindir = root / f"{kind}-{version.replace(os.sep, '-')}" / "bin"
    bindir.mkdir(parents=True, exist_ok=True, mode=0o755)
    return bindir


def expose_tool(env, binary, kind):
    """Return a directory that provides `kind` and nothing else.

    Shared bins such as ci-pinned contain several tools. Prepending
    the whole directory to surface pnpm 12.10 also surfaces the pinned Node,
    which can be older than the Node stage_environment already selected.
    """
    parent = binary.parent
    try:
        shared = any(
            entry.name != kind
            and not entry.name.startswith(".")
            and entry.is_file()
            and os.access(entry, os.X_OK)
            for entry in parent.iterdir()
        )
    except OSError:
        return parent
    if not shared:
        return parent
    stat = binary.stat()
    digest = f"{stat.st_mtime_ns:x}-{stat.st_size:x}-{stat.st_ino:x}"
    bindir = shim_bindir(env, kind, digest)
    link = bindir / kind
    target = binary.resolve()
    if not link.is_symlink() or link.resolve() != target:
        if link.is_symlink() or link.exists():
            link.unlink()
        link.symlink_to(target)
    return bindir


def declared_pnpm_version(workspace):
    for path in (
        workspace / "package.json",
        workspace / "console" / "package.json",
        workspace / "apps" / "web" / "package.json",
    ):
        if not path.is_file():
            continue
        try:
            data = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        manager = data.get("packageManager") or ""
        if isinstance(manager, str) and manager.startswith("pnpm@"):
            version = manager.split("@", 1)[1].strip()
            if version:
                return version
    return None


def corepack_pnpm_bindir(version, env, cwd):
    probe(["corepack", "prepare", f"pnpm@{version}", "--activate"], env, cwd)
    code, output = probe(["corepack", "pnpm", "--version"], env, cwd)
    if code != 0 or not version_ok(output, version):
        return False
    bindir = shim_bindir(env, "pnpm", version)
    script = bindir / "pnpm"
    script.write_text('#!/bin/sh\nexec corepack pnpm "$@"\n')
    os.chmod(script, 0o755)
    return bindir


def uv_python_bindir(version, env, cwd):
    code, output = probe(["uv", "python", "find", version], env, cwd)
    if code != 0:
        return False
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    if not lines:
        return False
    binary = Path(lines[-1])
    if not binary.is_file():
        return False
    bindir = binary.parent
    python3 = bindir / "python3"
    if python3.is_file() or python3.is_symlink():
        return bindir
    shim = shim_bindir(env, "python3", version) / "python3"
    if shim.exists() or shim.is_symlink():
        shim.unlink()
    shim.symlink_to(binary)
    return shim.parent


def path_tool_bins(kind, version, env):
    found = []
    for directory in env.get("PATH", "").split(os.pathsep):
        if directory:
            found.append(Path(directory) / kind)
    major = version.split(".")[0]
    if kind == "node" and major.isdigit():
        found.append(Path(f"/opt/homebrew/opt/node@{major}/bin/node"))
    return found


def find_tool_bin(kind, version, env, cwd):
    seen = []
    candidates = [
        *tool_candidates(kind, version, env),
        *path_tool_bins(kind, version, env),
    ]
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.append(candidate)
        if not candidate.is_file() or not os.access(candidate, os.X_OK):
            continue
        code, output = probe([str(candidate), "--version"], env, cwd)
        if code == 0 and version_ok(output, version):
            bindir = expose_tool(env, candidate, kind)
            current = [part for part in env.get("PATH", "").split(os.pathsep) if part]
            if current and current[0] == str(bindir):
                return None
            return bindir
    code, output = probe([kind, "--version"], env, cwd)
    if code == 0 and version_ok(output, version):
        return None
    if kind == "pnpm":
        located = corepack_pnpm_bindir(version, env, cwd)
        if located is not False:
            return located
    if kind in {"python", "python3"}:
        located = uv_python_bindir(version, env, cwd)
        if located is not False:
            return located
    return False


def prepend_path(env, bindir):
    updated = dict(env)
    updated["PATH"] = str(bindir) + os.pathsep + updated.get("PATH", "")
    return updated


def activate_declared_pnpm(env, workspace):
    version = declared_pnpm_version(workspace)
    if not version:
        return env, None
    located = corepack_pnpm_bindir(version, env, workspace)
    if located is False:
        return env, f"corepack cannot provide pnpm {version}"
    return prepend_path(env, located), None


def promote_required_tools(env, stage, workspace):
    updated = dict(env)
    for item in stage.get("require") or []:
        if not isinstance(item, dict) or item.get("kind") != "tool":
            continue
        name = item.get("tool")
        version = item.get("version")
        if not isinstance(name, str) or not version:
            continue
        located = find_tool_bin(name, str(version), updated, workspace)
        if located is not None and located is not False:
            updated = prepend_path(updated, located)
    return updated


def sysctl_model():
    try:
        return subprocess.check_output(
            ["/usr/sbin/sysctl", "-n", "hw.model"],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        return ""


def timeout_factor(env, model):
    """Virtualized fleet nodes keep the same suites with doubled budgets.

    tart guests report a VirtualMac hardware model while physical nodes
    report their real model, so consumers can scale per-test timeouts.
    An operator-provided value always wins.
    """
    preset = env.get("MINI_CI_TIMEOUT_FACTOR", "")
    if preset:
        return preset
    return "2" if model.startswith("VirtualMac") else "1"


def stage_environment(base, stage, workspace):
    env = with_host_path(dict(base))
    extra = stage.get("env") or {}
    if not isinstance(extra, dict):
        raise Stop("infrastructure", f"stage {stage['id']} env must be an object")
    for key, value in extra.items():
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", str(key)):
            raise Stop("infrastructure", f"invalid stage env key {key}")
        env[str(key)] = str(value)
    env["MINI_CI_TIMEOUT_FACTOR"] = timeout_factor(env, sysctl_model())
    missing = []
    wants_pnpm = "pnpm" in stage.get("toolchain", {}) or any(
        isinstance(item, dict)
        and item.get("kind") == "tool"
        and item.get("tool") == "pnpm"
        for item in stage.get("require") or []
    )
    if wants_pnpm:
        env, pnpm_err = activate_declared_pnpm(env, workspace)
        if pnpm_err:
            missing.append("pnpm " + (declared_pnpm_version(workspace) or "declared"))
    for kind, version in stage.get("toolchain", {}).items():
        located = find_tool_bin(kind, version, env, workspace)
        if located is False:
            missing.append(f"{kind} {version}")
        elif located is not None:
            env = prepend_path(env, located)
    env.pop("VIRTUAL_ENV", None)
    env["MINI_CI_ENV_ID"] = "/".join(
        part
        for part in (
            env.get("GITHUB_REPOSITORY") or env.get("MINI_CI_REPO") or "local",
            (env.get("GITHUB_SHA") or env.get("MINI_CI_SHA") or "local")[:12],
            stage["id"],
        )
        if part
    )
    return env, missing


def activate_venv(env, workspace, relative):
    bindir = workspace / relative / "bin"
    if not bindir.is_dir():
        return env, f"virtualenv {relative} is missing after prepare"
    updated = dict(env)
    updated["VIRTUAL_ENV"] = str(workspace / relative)
    updated["PATH"] = str(bindir) + os.pathsep + updated.get("PATH", "")
    return updated, None


def load_stage_env_file(env, workspace):
    path = workspace / "ci-stage.env"
    if not path.is_file():
        return env
    lines = path.read_text().splitlines()[:32]
    path.unlink()
    updated = dict(env)
    for line in lines:
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise Stop("environment", f"invalid ci-stage.env line: {line[:80]}")
        key, value = line.split("=", 1)
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            raise Stop("environment", f"invalid ci-stage.env key: {key}")
        updated[key] = value
    return updated


def accept_item(item, env, workspace):
    if not isinstance(item, dict):
        return {
            "ok": False,
            "required": item,
            "actual": None,
            "reason": "requirement must be an object",
        }
    kind = item.get("kind")
    if kind is None:
        for candidate in ("tool", "file", "env", "playwright", "command"):
            if candidate in item:
                kind = candidate
                break
    if kind == "tool":
        name = item.get("tool")
        argv = item.get("args") or [name, "--version"]
        if not isinstance(name, str) or not isinstance(argv, list):
            return {
                "ok": False,
                "required": item,
                "actual": None,
                "reason": "invalid tool requirement",
            }
        code, output = probe(argv, env, workspace)
        expected = item.get("version")
        prefix = item.get("version_prefix")
        reason = None
        if code != 0:
            reason = f"{name} exited {code}: {output.strip()[:300]}"
        elif expected and not version_ok(output, str(expected)):
            reason = f"{name} is {output.strip()[:200]!r}, required {expected}"
        elif prefix and prefix not in output:
            reason = f"{name} is {output.strip()[:200]!r}, required prefix {prefix}"
        return {
            "ok": reason is None,
            "required": {key: item[key] for key in item if key != "args"},
            "actual": output.strip()[:300],
            "reason": reason,
        }
    if kind == "file":
        raw = item.get("file")
        path = Path(str(raw))
        full = path if path.is_absolute() else (workspace / path).resolve()
        inside = (
            path.is_absolute()
            or str(full).startswith(str(workspace.resolve()) + os.sep)
            or full == workspace.resolve()
        )
        ok = bool(raw) and inside and full.is_file()
        reason = None if ok else f"missing file {raw}"
        return {
            "ok": ok,
            "required": {"file": raw},
            "actual": str(full) if ok else None,
            "reason": reason,
        }
    if kind == "env":
        name = str(item.get("env", ""))
        present = bool(env.get(name))
        return {
            "ok": present,
            "required": {"env": name},
            "actual": "present" if present else "absent",
            "reason": None if present else f"credential or variable {name} is not set",
        }
    if kind == "playwright":
        names = item.get("playwright") or []
        cache = Path(env.get("HOME", str(Path.home()))) / "Library/Caches/ms-playwright"
        found = [entry.name for entry in cache.iterdir()] if cache.is_dir() else []
        missing = [
            name for name in names if not any(entry.startswith(name) for entry in found)
        ]
        return {
            "ok": not missing and isinstance(names, list),
            "required": {"playwright": names},
            "actual": {name: name not in missing for name in names},
            "reason": None
            if not missing
            else "playwright browsers missing: " + ", ".join(missing),
        }
    if kind == "command":
        argv = item.get("command")
        if (
            not isinstance(argv, list)
            or not argv
            or not all(isinstance(part, str) for part in argv)
        ):
            return {
                "ok": False,
                "required": item,
                "actual": None,
                "reason": "invalid command requirement",
            }
        code, output = probe(argv, env, workspace)
        pattern = item.get("matches")
        reason = None
        if code != 0:
            reason = f"{argv[0]} exited {code}: {output.strip()[:300]}"
        elif pattern and re.search(pattern, output) is None:
            reason = f"output does not match {pattern}: {output.strip()[:200]}"
        return {
            "ok": reason is None,
            "required": {"command": argv, "matches": pattern},
            "actual": output.strip()[:300],
            "reason": reason,
        }
    return {
        "ok": False,
        "required": item,
        "actual": None,
        "reason": "unknown requirement",
    }


def conclusion_text(value):
    return {
        "passed": "通过",
        "environment": "环境失败",
        "check": "项目检查失败",
        "infrastructure": "基础设施故障",
        "interrupted": "中断",
        "incomplete": "未完成",
    }.get(value, value)


def cell(value):
    return str(value or "—").replace("|", "/").replace("\n", " ")[:180]


def markdown(report):
    pr = "#" + str(report["pr"]) if report.get("pr") is not None else "—"
    lines = [
        f"# 主动检查 · {report['repo']}",
        "",
        f"- 结论：{conclusion_text(report['conclusion'])}",
        f"- PR：{pr}",
        f"- 待测提交：`{report.get('sha') or '—'}`",
        f"- 请求者：{report.get('requester') or '—'}",
        "- 运行：{} / 尝试 {}".format(
            report.get("run_id") or "—", report.get("run_attempt") or "—"
        ),
        f"- 节点：{report.get('node') or '—'}",
        f"- 共享实现：`{report.get('shared_ref') or '—'}`",
        "",
        "## 阶段",
        "",
        "| 阶段 | 状态 | 耗时 | 说明 |",
        "| --- | --- | --- | --- |",
    ]
    for phase in report.get("phases", []):
        seconds = phase.get("seconds")
        shown = f"{seconds:.1f}s" if isinstance(seconds, (int, float)) else "—"
        detail = cell(phase.get("reason") or phase.get("detail"))
        lines.append(
            "| {} | {} | {} | {} |".format(
                cell(phase.get("id")),
                cell(phase.get("status")),
                shown,
                detail,
            )
        )
    if report.get("failure"):
        lines.extend(["", "## 失败原因", "", report["failure"]])
    if report.get("diagnostics"):
        lines.extend(["", f"诊断：`{report['diagnostics']}`"])
    for stage in report.get("stages", []):
        lines.extend(["", f"## 环境 · {stage['id']}", ""])
        for item in stage.get("accept", []):
            required = json.dumps(item.get("required"), ensure_ascii=False)
            actual = json.dumps(item.get("actual"), ensure_ascii=False)
            mark = "符合" if item.get("ok") else "不符合"
            lines.append(f"- {mark}：要求 `{required}`，实际 `{actual}`")
    lines.append("")
    return "\n".join(lines)


def blank_report(env, payload):
    repo = env.get("GITHUB_REPOSITORY") or env.get("MINI_CI_REPO") or "local/local"
    pr = None
    requester = env.get("MINI_CI_REQUESTER")
    head = None
    if payload:
        pr = (payload.get("pull_request") or {}).get("number")
        requester = ((payload.get("sender") or {}).get("login")) or requester
        head = ((payload.get("pull_request") or {}).get("head") or {}).get("sha")
    if env.get("MINI_CI_PR"):
        pr = int(env["MINI_CI_PR"])
    attempt = env.get("GITHUB_RUN_ATTEMPT") or env.get("MINI_CI_ATTEMPT")
    runs_on = []
    if env.get("MINI_CI_RUNS_ON"):
        try:
            runs_on = json.loads(env["MINI_CI_RUNS_ON"])
        except json.JSONDecodeError as exc:
            raise Stop("infrastructure", f"MINI_CI_RUNS_ON is not JSON: {exc}") from exc
        if not isinstance(runs_on, list):
            raise Stop("infrastructure", "MINI_CI_RUNS_ON must be a JSON array")
    return {
        "schema": SCHEMA,
        "repo": repo,
        "repo_dir": repo_dir_name(repo),
        "pr": pr,
        "sha": env.get("GITHUB_SHA") or env.get("MINI_CI_SHA") or "",
        "pr_head": head,
        "requester": requester,
        "run_id": env.get("GITHUB_RUN_ID") or env.get("MINI_CI_RUN_ID"),
        "run_attempt": int(attempt) if attempt else None,
        "node": env.get("RUNNER_NAME") or env.get("MINI_CI_NODE"),
        "shared_ref": env.get("MINI_CI_SHARED_REF") or None,
        "runs_on": runs_on,
        "host": {},
        "permissions": [],
        "phase": "request",
        "conclusion": "incomplete",
        "env_ok": None,
        "failure": None,
        "diagnostics": None,
        "phases": [],
        "stages": [],
    }


def publish(report, workspace, state_root):
    text = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    rendered = markdown(report)
    atomic_write(workspace / "ci-report.json", text)
    atomic_write(workspace / "ci-report.md", rendered)
    atomic_write(state_root / "reports" / f"{report['repo_dir']}.json", text)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        try:
            with open(summary, "a", encoding="utf-8") as handle:
                handle.write("\n" + rendered)
        except OSError:
            pass


def write_diagnostics(report, workspace, state_root, stdout, stderr):
    body = ((stdout or "") + ("\n" + stderr if stderr else "")).strip()
    if not body:
        return
    name = "{}-{}-{}.log".format(
        report["repo_dir"],
        report.get("run_id") or "local",
        report.get("run_attempt") or 0,
    )
    path = state_root / "diagnostics" / name
    atomic_write(path, body[-20000:])
    atomic_write(workspace / "ci-diagnostics" / name, body[-20000:])
    report["diagnostics"] = str(path)


def lease_status(env, state_root):
    if env.get("MINI_CI_LEASE") == "local" or (
        env.get("GITHUB_ACTIONS") != "true" and env.get("MINI_CI_LEASE") != "required"
    ):
        return "ok", "local"
    owner_path = Path(state_root) / "owner.json"
    if not owner_path.is_file():
        return (
            "failed",
            "node lease is not held; the job-started hook did not record an owner",
        )
    try:
        owner = json.loads(owner_path.read_text())
    except json.JSONDecodeError:
        return "failed", "node lease owner record is unreadable"
    pid = owner.get("pid")
    if type(pid) is not int or pid < 1:
        return "failed", "node lease owner has no pid"
    try:
        output = subprocess.check_output(
            ["/bin/ps", "-o", "pid=,ppid=", "-ax"], text=True
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        return "failed", f"cannot inspect the lease process: {exc}"
    parents = {}
    for line in output.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
            parents[int(parts[0])] = int(parts[1])
    seen = set()
    current = os.getpid()
    while current and current not in seen:
        seen.add(current)
        if current == pid:
            return "ok", f"lease pid {pid}"
        current = parents.get(current, 0)
    return "failed", f"node lease is held by pid {pid}, which is not this job"


def git_head(workspace):
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=workspace, text=True
        ).strip()
    except (OSError, subprocess.CalledProcessError) as exc:
        raise Stop("infrastructure", f"cannot read workspace HEAD: {exc}") from exc


def audit_caller(text, same_repo):
    errors = []
    if re.search(r"(?m)^\s*push\s*:", text) or re.search(r"(?m)^\s*schedule\s*:", text):
        errors.append("push or schedule trigger")
    if "workflow_dispatch" in text:
        errors.append("workflow_dispatch added")
    if not re.search(r"types:\s*\[labeled\]", text):
        errors.append("pull_request is not limited to labeled")
    if "run-ci" not in text:
        errors.append("run-ci request missing")
    if "cancel-in-progress: false" not in text:
        errors.append("in-progress runs must not be cancelled")
    if "head.sha" in text:
        errors.append("checkout must not follow the moving PR head")
    if "github.event.pull_request.head.repo.full_name == github.repository" not in text:
        errors.append("fork pull requests must be rejected")
    if same_repo:
        if "./.github/workflows/reusable-quality.yml" not in text:
            errors.append("same-repo caller must use the local reusable workflow")
    elif not re.search(
        r"uses:\s*\S+/\.github/workflows/reusable-quality\.yml@[0-9a-f]{40}\s*$",
        text,
        re.MULTILINE,
    ):
        errors.append(
            "cross-repo caller must pin the shared workflow to a 40-character commit"
        )
    if not same_repo and re.search(r"@(main|master)\b", text):
        errors.append("a branch ref is not a controlled upgrade")
    pinned = re.search(
        r"uses:\s*\S+/\.github/workflows/reusable-quality\.yml@([0-9a-f]{40})",
        text,
    )
    engine = re.search(
        r"engine-ref:\s*([0-9a-f]{40}|\$\{\{\s*github\.sha\s*\}\})",
        text,
    )
    if not engine:
        errors.append("engine-ref input is missing")
    elif pinned and engine.group(1) != pinned.group(1):
        errors.append("engine-ref must repeat the pinned engine commit")
    return errors


def audit_reusable(text):
    errors = []
    if re.search(r"(?m)^\s*push\s*:", text) or re.search(r"(?m)^\s*schedule\s*:", text):
        errors.append("reusable workflow has push or schedule")
    if re.search(r"(?m)^\s*pull_request\s*:", text):
        errors.append("reusable workflow must not subscribe to pull_request")
    if "ref: ${{ github.sha }}" not in text:
        errors.append("checkout is not pinned to github.sha")
    if "head.sha" in text:
        errors.append("checkout follows the moving PR head")
    if "labels/run-ci" not in text:
        errors.append("run-ci label is not consumed")
    if (
        "raw.githubusercontent.com/yaindrop/mini-archipel" not in text
        or "ci-run.py" not in text
        or "ENGINE_REF: ${{ inputs.engine-ref }}" not in text
        or "GITHUB_SHA" not in text
    ):
        errors.append("the lifecycle must be fetched from the pinned engine commit")
    if "MINI_CI_REQUEST: run-ci" not in text:
        errors.append("explicit request is not passed to the lifecycle")
    return errors


def finish(report, workspace, state_root, conclusion, reason, code):
    report["conclusion"] = conclusion
    report["failure"] = reason
    if conclusion == "environment":
        report["env_ok"] = False
    elif conclusion == "check":
        report["env_ok"] = True
    report["phases"].append(
        {"id": "summary", "status": "failed", "seconds": 0, "reason": reason}
    )
    publish(report, workspace, state_root)
    raise SystemExit(code)


def execute(workspace, env, state_root, shell=run_shell, facts=host_facts):
    allowed, why = request_allowed(env)
    if not allowed:
        raise SystemExit(2)
    payload = load_event(env)
    report = blank_report(env, payload)
    previous_term = signal.getsignal(signal.SIGTERM)
    previous_int = signal.getsignal(signal.SIGINT)

    def on_signal(signum, _frame):
        report["conclusion"] = "interrupted"
        report["failure"] = f"received signal {signum}"
        publish(report, workspace, state_root)
        raise SystemExit(128 + signum)

    try:
        signal.signal(signal.SIGTERM, on_signal)
        signal.signal(signal.SIGINT, on_signal)
        report["host"] = facts()
        report["phases"].append(
            {"id": "request", "status": "ok", "seconds": 0, "detail": why}
        )
        publish(report, workspace, state_root)
        requirements = load_requirements(workspace / "ci/requirements.json")
        report["permissions"] = list(requirements.get("permissions", []))
        pinned = report["sha"]
        head = git_head(workspace)
        if not pinned or head != pinned:
            raise Stop(
                "infrastructure",
                "workspace HEAD {} is not the pinned commit {}".format(
                    head or "—", pinned or "—"
                ),
            )
        report["phase"] = "pin"
        report["phases"].append(
            {"id": "pin", "status": "ok", "seconds": 0, "detail": pinned}
        )
        status, detail = lease_status(env, state_root)
        if status != "ok":
            raise Stop("infrastructure", detail)
        report["phase"] = "lease"
        report["phases"].append(
            {"id": "lease", "status": "ok", "seconds": 0, "detail": detail}
        )
        script = workspace / "ci/prepare-workspace.sh"
        if script.is_file():
            code, stdout, stderr = shell("bash ci/prepare-workspace.sh", env, workspace)
            if code != 0:
                write_diagnostics(report, workspace, state_root, stdout, stderr)
                raise Stop("infrastructure", f"workspace preparation exited {code}")
        report["phase"] = "workspace"
        report["phases"].append({"id": "workspace", "status": "ok", "seconds": 0})
        reasons = host_gate(
            requirements["capabilities"], report["host"], report["runs_on"]
        )
        if reasons:
            report["phase"] = "accept:host"
            raise Stop("environment", "; ".join(reasons))
        report["phases"].append({"id": "accept:host", "status": "ok", "seconds": 0})
        publish(report, workspace, state_root)
        for stage in requirements["stages"]:
            stage_env, missing = stage_environment(env, stage, workspace)
            if missing:
                report["phase"] = f"prepare:{stage['id']}"
                raise Stop(
                    "environment",
                    "toolchain is not installed; operations must provide "
                    + ", ".join(missing),
                )
            failure = None
            try:
                started = time.monotonic()
                report["phase"] = f"prepare:{stage['id']}"
                publish(report, workspace, state_root)
                code, stdout, stderr = shell(stage["prepare"], stage_env, workspace)
                report["phases"].append(
                    {
                        "id": f"prepare:{stage['id']}",
                        "status": "ok" if code == 0 else "failed",
                        "seconds": round(time.monotonic() - started, 3),
                    }
                )
                if code != 0:
                    write_diagnostics(report, workspace, state_root, stdout, stderr)
                    detail = (stderr or stdout or "").strip()[-400:]
                    raise Stop(
                        "environment", f"prepare {stage['id']} exited {code}: {detail}"
                    )
                stage_env = load_stage_env_file(stage_env, workspace)
                stage_env = promote_required_tools(stage_env, stage, workspace)
                if stage.get("venv"):
                    stage_env, verr = activate_venv(stage_env, workspace, stage["venv"])
                    if verr:
                        raise Stop("environment", verr)
                started = time.monotonic()
                report["phase"] = f"accept:{stage['id']}"
                publish(report, workspace, state_root)
                results = [
                    accept_item(item, stage_env, workspace)
                    for item in stage.get("require", [])
                ]
                failed = [item for item in results if not item["ok"]]
                report["stages"].append({"id": stage["id"], "accept": results})
                report["phases"].append(
                    {
                        "id": f"accept:{stage['id']}",
                        "status": "failed" if failed else "ok",
                        "seconds": round(time.monotonic() - started, 3),
                        "reason": failed[0]["reason"] if failed else None,
                    }
                )
                if failed:
                    raise Stop("environment", failed[0]["reason"])
                started = time.monotonic()
                report["phase"] = f"check:{stage['id']}"
                publish(report, workspace, state_root)
                code, stdout, stderr = shell(stage["check"], stage_env, workspace)
                report["phases"].append(
                    {
                        "id": f"check:{stage['id']}",
                        "status": "ok" if code == 0 else "failed",
                        "seconds": round(time.monotonic() - started, 3),
                    }
                )
                if code != 0:
                    write_diagnostics(report, workspace, state_root, stdout, stderr)
                    detail = (stderr or stdout or "").strip()[-400:]
                    raise Stop("check", f"check {stage['id']} exited {code}: {detail}")
            except Stop as exc:
                failure = exc
            except Exception as exc:
                failure = Stop("infrastructure", str(exc))
            finally:
                if stage.get("cleanup"):
                    code, stdout, stderr = shell(stage["cleanup"], stage_env, workspace)
                    report["phases"].append(
                        {
                            "id": f"cleanup:{stage['id']}",
                            "status": "ok" if code == 0 else "failed",
                            "seconds": 0,
                        }
                    )
                    if code != 0:
                        write_diagnostics(report, workspace, state_root, stdout, stderr)
                        cleanup = f"cleanup {stage['id']} exited {code}"
                        if failure is None:
                            failure = Stop("infrastructure", cleanup)
                        else:
                            failure.reason = f"{failure.reason}; {cleanup}"
            if failure:
                raise failure
        report["env_ok"] = True
        report["conclusion"] = "passed"
        report["phase"] = "summary"
        report["failure"] = None
        report["phases"].append({"id": "summary", "status": "ok", "seconds": 0})
        publish(report, workspace, state_root)
        return report
    except Stop as exc:
        finish(report, workspace, state_root, exc.conclusion, exc.reason, 1)
    except SystemExit:
        raise
    except Exception as exc:
        finish(report, workspace, state_root, "infrastructure", str(exc), 1)
    finally:
        signal.signal(signal.SIGTERM, previous_term)
        signal.signal(signal.SIGINT, previous_int)


def main():
    workspace = Path(os.environ.get("MINI_CI_WORKSPACE", os.getcwd()))
    state = Path(os.environ.get("MINI_CI_STATE", Path.home() / ".local/state/mini-ci"))
    try:
        execute(workspace, dict(os.environ), state)
    except SystemExit as exc:
        return exc.code if isinstance(exc.code, int) else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
