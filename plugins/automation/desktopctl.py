#!/usr/bin/env python3
"""Authenticated Mini Archipel plugin client. Token comes from ARCHIPEL_TOKEN."""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse


def call(base, token, action, body):
    request = urllib.request.Request(base.rstrip("/") + "/api/plugins/automation/actions/" + action,
                                     data=json.dumps(body).encode(), headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        try:
            detail = json.load(error).get("error", "Request failed")
        except ValueError:
            detail = "Request failed"
        raise RuntimeError(f"HTTP {error.code}: {detail}") from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True, help="Console base URL, never an Agent token URL")
    parser.add_argument("--host", required=True, help="Configured node ID")
    parser.add_argument("action", choices=["capabilities", "status", "submit", "get", "wait", "cancel", "pause", "resume", "diagnostics", "input-info", "input-log", "stop-input", "resume-input"])
    parser.add_argument("request_id", nargs="?")
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--timeout", type=int, default=120)
    args = parser.parse_args()
    parsed = urlparse(args.url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        parser.error("Use a plain http(s) Console base URL")
    token = os.environ.get("ARCHIPEL_TOKEN")
    if not token:
        parser.error("Set ARCHIPEL_TOKEN to the Console API token")
    body = {"host": args.host}
    action = args.action
    if action == "capabilities":
        action = "status"
    if action == "submit":
        raw = sys.stdin.read(300001)
        if len(raw) > 300000:
            parser.error("Request too large")
        body["request"] = json.loads(raw)
    if action in {"get", "wait", "cancel", "input-log"}:
        if not args.request_id:
            parser.error("A request ID is required")
        body["request_id"] = args.request_id
    if action == "input-log":
        body["offset"] = args.offset
    if action in {"stop-input", "resume-input"}:
        body["stopped"] = action == "stop-input"
        action = "input-stop"
    if action in {"pause", "resume"}:
        body["paused"] = action == "pause"
        action = "coordinate"
    if action == "wait":
        deadline = time.monotonic() + max(1, min(args.timeout, 900))
        while True:
            result = call(args.url, token, "get", body)
            if result["job"]["status"] not in {"queued", "running", "waiting_user"} or time.monotonic() >= deadline:
                break
            time.sleep(1)
    else:
        result = call(args.url, token, action, body)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        sys.exit(1)
