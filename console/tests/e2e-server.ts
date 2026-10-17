import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serverPlugins } from "../src/plugins/catalog.server.ts";
import { createApp } from "../src/app.ts";
import { Store } from "../src/store.ts";
import { UpstreamError, type Transport } from "../src/fleet.ts";
import {
  config,
  makeHost,
  makeSnapshot,
  fixtureRunnerData,
} from "./fixtures.ts";
const dir = mkdtempSync(join(tmpdir(), "fleet-browser-")),
  dbPath = join(dir, "test.db");
const store = new Store(dbPath);
store.insertSamples(
  config.hosts.flatMap((h, index) =>
    Object.entries(makeHost(index).history).flatMap(([key, points]) =>
      points.map((point) => ({ host: h.name, key, ...point })),
    ),
  ),
);
store.close();
const offline = new Set<string>(),
  stopped = new Set<string>(),
  interrupted = new Set<string>(),
  disabledPlugins = new Set<string>();
const scans = new Map<string, ReturnType<typeof makeSnapshot>["disk_scan"]>();
let multiRepo = false;
const transport: Transport = (url, _token, body) => {
  const index = config.hosts.findIndex((h) => url.startsWith(h.url)),
    name = config.hosts[index]?.name ?? "";
  if (offline.has(name))
    return Promise.reject(new UpstreamError(502, "模拟节点离线"));
  const snapshot = makeSnapshot(index);
  snapshot.disk_scan = scans.get(name) ?? snapshot.disk_scan;
  snapshot.disk_scans.reverse(); // Transport order must not determine the root selector order.
  if (url.endsWith("/rescan-disk")) {
    const now = Date.now();
    scans.set(name, {
      id: now,
      status: "running",
      requested_at: now,
      started_at: now,
      finished_at: null,
      current_root: "/",
      error: null,
    });
  }
  if (url.endsWith("/cancel-disk-scan")) {
    const job = scans.get(name);
    if (job)
      scans.set(name, {
        ...job,
        status: "cancelled",
        finished_at: Date.now(),
        current_root: null,
      });
  }
  if (url.endsWith("/snapshot")) {
    const runners = fixtureRunnerData(snapshot).runners;
    if (multiRepo && index === 0 && runners[0])
      runners.push({
        ...runners[0],
        repo: "acme/flowbit",
        repo_dir: "acme-flowbit",
        listener_pid: 1100,
      });
    for (const runner of runners) {
      if (stopped.has(`${name}:${runner.repo_dir}`)) runner.listener_pid = null;
      if (interrupted.has(`${name}:${runner.repo_dir}`))
        runner.worker_pid = null;
    }
    if (disabledPlugins.has(name))
      snapshot.plugins.runners = {
        version: 2,
        enabled: false,
        status: "disabled",
        ts: Date.now(),
        data: null,
        error: null,
      };
    return Promise.resolve(snapshot);
  }
  if (
    url.endsWith("/plugins/runners/actions/interrupt") &&
    typeof body === "object" &&
    body !== null &&
    "runner" in body &&
    typeof body.runner === "string"
  )
    interrupted.add(`${name}:${body.runner}`);
  if (
    url.endsWith("/plugins/runners/actions/toggle") &&
    typeof body === "object" &&
    body !== null &&
    "enable" in body &&
    "runner" in body &&
    typeof body.runner === "string"
  ) {
    if (body.enable) stopped.delete(`${name}:${body.runner}`);
    else stopped.add(`${name}:${body.runner}`);
  }
  if (
    url.endsWith("/plugins/runners") &&
    typeof body === "object" &&
    body !== null &&
    "enabled" in body
  ) {
    if (body.enabled) disabledPlugins.delete(name);
    else disabledPlugins.add(name);
  }
  return Promise.resolve({ ok: true });
};
const { app, monitor, plugins } = createApp(
  { ...config, dbPath },
  { webDir: resolve("dist/web"), transport, plugins: serverPlugins },
);
app.post<{ Params: { name: string }; Body: { offline: boolean } }>(
  "/__test/host/:name",
  async (request) => {
    if (request.body.offline) offline.add(request.params.name);
    else offline.delete(request.params.name);
    await monitor.poll();
    return { ok: true };
  },
);
app.post("/__test/reset", async () => {
  multiRepo = false;
  scans.clear();
  offline.clear();
  stopped.clear();
  interrupted.clear();
  disabledPlugins.clear();
  await plugins.setEnabled("runners", true);
  await monitor.poll();
  return { ok: true };
});
app.post("/__test/multi-repo", async () => {
  multiRepo = true;
  await monitor.poll();
  return { ok: true };
});
await monitor.poll();
await app.listen({ host: "127.0.0.1", port: 19101 });
for (const sig of ["SIGTERM", "SIGINT"] as const)
  process.once(sig, () => {
    void app.close().finally(() => {
      rmSync(dir, { recursive: true, force: true });
    });
  });
