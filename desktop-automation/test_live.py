"""Explicit live acceptance: sends test messages and opens node authorization settings."""
import argparse
import json
import os
from pathlib import Path
import time
import uuid
from desktopctl import call


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--host", required=True)
    parser.add_argument("--codex-thread", required=True)
    parser.add_argument("--zcode-session", help="Omit to create and continue a dedicated test chat")
    parser.add_argument("--run-id", help="Reuse a prior tag to reconcile its completed checks")
    parser.add_argument("--report", required=True)
    args = parser.parse_args()
    token = os.environ["ARCHIPEL_TOKEN"]
    tag = args.run_id or uuid.uuid4().hex[:8]
    report = {"tag": tag, "checks": []}
    def record(name, **data):
        report["checks"].append({"name": name, **data})
        Path(args.report).write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps({"name": name, **data}, ensure_ascii=False), flush=True)
    def invoke(action, **data):
        return call(args.url, token, action, {"host": args.host, **data})
    def wait(job_id):
        deadline = time.monotonic() + 130
        while time.monotonic() < deadline:
            job = invoke("get", request_id=job_id)["job"]
            if job["status"] not in {"queued", "running", "waiting_user"}:
                return job
            time.sleep(.3)
        raise AssertionError("Live test timed out; recover original ID " + job_id)
    def run(name, **fields):
        request = {"request_id": "plugin-" + tag + "-" + name, **fields}
        started = time.monotonic()
        accepted = invoke("submit", request=request)
        admission_ms = round((time.monotonic() - started) * 1000)
        assert accepted["ok"] and admission_ms < 5000
        job = wait(request["request_id"])
        assert job["status"] == "completed", job
        record(name, ok=True, request_id=request["request_id"], admission_ms=admission_ms,
               total_ms=round((time.monotonic()-started)*1000), result=job["result"])
        return request, job
    try:
        run("doctor", operation="doctor", timeout=30)
        run("permissions", operation="permissions", permission="automation", timeout=60)
        literal = "中文 'quotes' $HOME $(echo literal) `literal`\nnext line"
        script, job = run("literal-script", operation="script", mode="exec", path="/usr/bin/printf", arguments=["%s", literal])
        assert job["result"]["stdout"] == literal
        invoke("coordinate", paused=True)
        try:
            assert invoke("submit", request=script)["reused"] is True
            try:
                invoke("submit", request={**script, "request_id": "plugin-"+tag+"-paused"})
            except RuntimeError as error:
                assert "409" in str(error)
            else:
                raise AssertionError("Paused node accepted new work")
            record("pause-and-replay", ok=True)
        finally:
            invoke("coordinate", paused=False)
        cancel_id = "plugin-"+tag+"-cancel"
        invoke("submit", request={"request_id":cancel_id, "operation":"script", "mode":"exec", "path":"/bin/sleep", "arguments":["30"]})
        time.sleep(.5)
        invoke("cancel", request_id=cancel_id)
        assert wait(cancel_id)["status"] == "cancelled"
        record("cancel", ok=True, request_id=cancel_id)
        for app, target in [("codex", args.codex_thread), ("zcode", args.zcode_session)]:
            expected = "PLUGIN_" + app.upper() + "_" + tag
            name = app if target else app+"-new"
            request, job = run(name, operation="chat", app=app, mode="send" if target else "new", **({"target": target} if target else {}),
                               message="插件集成验收，不要使用工具或修改文件，只回复 " + expected + "。")
            assert job["result"]["reply"].strip() == expected
            replay = invoke("submit", request=request)
            assert replay["reused"] is True and replay["job"]["result"] == job["result"]
            record(app+"-replay", ok=True)
            if not target:
                followup = expected + "_AGAIN"
                _, continued = run("zcode-continue", operation="chat", app="zcode", mode="send", target=job["result"]["session_id"], message="不要调用工具或修改文件，只回复 " + followup + "。")
                assert continued["result"]["reply"].strip() == followup
        diagnostics = invoke("diagnostics")["report"]
        serialized = json.dumps(diagnostics,ensure_ascii=False)
        assert literal not in serialized and token not in serialized and "插件集成验收" not in serialized
        record("diagnostics", ok=True)
        run("final-doctor", operation="doctor", timeout=30)
        report["ok"] = True
    except Exception as error:
        report.update(ok=False, error=str(error))
        raise
    finally:
        Path(args.report).write_text(json.dumps(report,ensure_ascii=False,indent=2))


if __name__ == "__main__":
    main()
