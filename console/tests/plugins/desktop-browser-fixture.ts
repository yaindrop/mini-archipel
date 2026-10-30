import type { Snapshot } from "../../src/contracts.ts";
import { UpstreamError } from "../../src/archipel.ts";
import {
  JobRequestSchema,
  type DesktopJob,
} from "../../src/plugins/desktop-automation/contracts.ts";
import { desktopFixture } from "./desktop-fixture.ts";

export function desktopBrowserFixture() {
  let enabled = false;
  const states = new Map<string, ReturnType<typeof desktopFixture>>();
  const requests = new Map<string, string>();
  function state(name: string) {
    let value = states.get(name);
    if (!value) {
      value = desktopFixture();
      states.set(name, value);
    }
    if (!value.toolkit) throw Error("fixture missing");
    return value;
  }
  return {
    enable() {
      enabled = true;
    },
    reset() {
      enabled = false;
      states.clear();
      requests.clear();
    },
    apply(name: string, snapshot: Snapshot) {
      if (enabled)
        snapshot.plugins["desktop-automation"] = {
          version: 1,
          enabled: true,
          status: "ready",
          ts: Date.now(),
          error: null,
          data: structuredClone(state(name)),
        };
    },
    action(name: string, action: string, body: unknown) {
      const toolkit = state(name).toolkit;
      if (!toolkit || !body || typeof body !== "object")
        throw Error("fixture missing");
      if (action === "status") return { ok: true, data: toolkit };
      if (action === "diagnostics")
        return {
          ok: true,
          report: {
            state: { paused: toolkit.paused },
            versions: { test: "1" },
          },
        };
      if (action === "coordinate" && "paused" in body) {
        toolkit.paused = body.paused === true;
        return { ok: true, data: toolkit };
      }
      if (action === "submit") {
        const request = JobRequestSchema.parse(body);
        const prior = toolkit.jobs.find((j) => j.id === request.request_id);
        const key = name + ":" + request.request_id;
        if (prior) {
          if (requests.get(key) !== JSON.stringify(request))
            throw new UpstreamError(409, "conflicting request ID");
          return { ok: true, job: prior, reused: true };
        }
        if (toolkit.paused) throw new UpstreamError(409, "paused");
        const job: DesktopJob = {
          id: request.request_id,
          operation: request.operation,
          status: "running",
          created_at: Date.now() / 1000,
          updated_at: Date.now() / 1000,
          error: null,
        };
        toolkit.jobs.unshift(job);
        toolkit.desktop_busy = true;
        requests.set(key, JSON.stringify(request));
        setTimeout(
          () => {
            if (job.status === "running") {
              job.status = "completed";
              job.updated_at = Date.now() / 1000;
              job.result = { ok: true, reply: "FIXTURE_REPLY" };
            }
            toolkit.desktop_busy = false;
          },
          request.operation === "script" ? 10000 : 300,
        );
        return { ok: true, job, reused: false };
      }
      if ((action === "get" || action === "cancel") && "request_id" in body) {
        const job = toolkit.jobs.find((j) => j.id === body.request_id);
        if (!job) throw new UpstreamError(404, "job missing");
        if (action === "cancel") {
          job.status = "cancelled";
          toolkit.desktop_busy = false;
        }
        return { ok: true, job };
      }
      throw new UpstreamError(400, "unknown desktop fixture action");
    },
  };
}
