import {
  DiskRulesUpdateSchema,
  type DiskRulesView,
} from "../src/storage-rules.ts";
import type { ScanNode } from "../src/contracts.ts";
import { fanFixture } from "./plugins/fan-fixture.ts";
import { CommandSchema } from "../src/plugins/fan-control/contracts.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
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
await store.insertSamples(
  config.hosts.flatMap((h, index) =>
    Object.entries(makeHost(index).history).flatMap(([key, points]) =>
      points.map((point) => ({ host: h.name, key, ...point })),
    ),
  ),
);
await store.close();
const offline = new Set<string>(),
  stopped = new Set<string>(),
  interrupted = new Set<string>(),
  disabledPlugins = new Set<string>();
const scans = new Map<string, ReturnType<typeof makeSnapshot>["disk_scan"]>();
const exclusive = new Set<string>(),
  runnerJobs = new Map<string, string>();
type RunnerOperation = NonNullable<
  ReturnType<typeof fixtureRunnerData>["operations"]
>[number];
const runnerOperations = new Map<string, RunnerOperation[]>();
const directoryResults = new Map<
  string,
  Map<string, ReturnType<typeof makeSnapshot>["disk_scans"][number]>
>();
function applyDirectories(
  name: string,
  snapshot: ReturnType<typeof makeSnapshot>,
) {
  for (const [path, replacement] of directoryResults.get(name) ?? []) {
    for (const root of snapshot.disk_scans) {
      if (!path.startsWith(root.root + "/")) continue;
      let current = root;
      for (const part of path.slice(root.root.length + 1).split("/")) {
        const child = current.children.find((row) => row.root === part);
        if (!child) break;
        current = child;
      }
      if (current.root === replacement.root)
        Object.assign(current, structuredClone(replacement));
    }
  }
}
let multiRepo = false;
let fanEnabled = false;
const fans = new Map<string, ReturnType<typeof fanFixture>>();
const directoryRules = new Map<string, DiskRulesView>();
function ruleFixture(name: string): DiskRulesView {
  return {
    revision: "v1",
    home: "/Users/" + name,
    roots: ["/", "/Users/" + name],
    config: { use_defaults: true, rules: [] },
    defaults: [
      { path: "~/Library", depth: 1, class: "library" },
      { path: "~/.cache", depth: 1, class: "reclaimable" },
    ],
    plugins: [{ plugin: "runners", path: "/Users/" + name + "/runners" }],
  };
}
const transport: Transport = (url, _token, body) => {
  const index = config.hosts.findIndex((h) => url.startsWith(h.url)),
    name = config.hosts[index]?.name ?? "";
  if (offline.has(name))
    return Promise.reject(new UpstreamError(502, "模拟节点离线"));
  if (url.endsWith("/disk-rules")) {
    const current = directoryRules.get(name) ?? ruleFixture(name);
    if (body !== undefined) {
      const update = DiskRulesUpdateSchema.parse(body);
      if (update.revision !== current.revision)
        return Promise.reject(new UpstreamError(409, "conflict"));
      const next = {
        ...current,
        config: update.config,
        revision: "v" + String(Number(current.revision.slice(1)) + 1),
      };
      directoryRules.set(name, next);
      return Promise.resolve(next);
    }
    return Promise.resolve(current);
  }
  const snapshot = makeSnapshot(index);
  applyDirectories(name, snapshot);
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
      current_root:
        body &&
        typeof body === "object" &&
        "path" in body &&
        typeof body.path === "string"
          ? body.path
          : "/",
      target:
        body &&
        typeof body === "object" &&
        "path" in body &&
        typeof body.path === "string"
          ? body.path
          : null,
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
  if (fanEnabled) {
    let fan = fans.get(name);
    if (!fan) {
      fan = fanFixture();
      fans.set(name, fan);
    }
    fan.sampled_at = Date.now();
    snapshot.plugins["fan-control"] = {
      version: 1,
      enabled: true,
      status: "ready",
      ts: Date.now(),
      error: null,
      data:
        index < 2
          ? fan
          : {
              availability: "unsupported",
              reason: "virtual_machine",
              reading: null,
              control_allowed: true,
              interval_ms: 2000,
            },
    };
    if (
      url.endsWith("/plugins/fan-control/actions/command") &&
      body &&
      typeof body === "object" &&
      "request_id" in body &&
      typeof body.request_id === "string"
    ) {
      const command = CommandSchema.parse({
        action: "action" in body ? body.action : undefined,
        data: "data" in body ? body.data : undefined,
      });
      if (
        "expected_revision" in body &&
        body.expected_revision !== fan.revision
      )
        return Promise.resolve({
          ok: false,
          status: 409,
          error: "revision_conflict",
        });
      if (command.action === "apply") {
        fan.revisions.push({
          revision: fan.revision,
          ts: Date.now(),
          policy: fan.policy,
        });
        fan.policy = command.data.policy;
        fan.revision = "b".repeat(64);
      }
      fan.jobs.push({
        id: body.request_id,
        action: command.action,
        status: command.action === "manual" ? "running" : "completed",
        requested_at: Date.now(),
        started_at: Date.now(),
        finished_at: command.action === "manual" ? null : Date.now(),
        phase: "running",
        progress: 0,
        total: 0,
        log: "",
        result: null,
        error: null,
        restored: null,
        expires_at: command.action === "manual" ? Date.now() + 30000 : null,
      });
      return Promise.resolve({ ok: true, job_id: body.request_id });
    }
    if (
      url.endsWith("/plugins/fan-control/actions/cancel") &&
      body &&
      typeof body === "object" &&
      "job_id" in body
    ) {
      const job = fan.jobs.find((j) => j.id === body.job_id);
      if (job) {
        job.status = "cancelled";
        job.finished_at = Date.now();
        job.restored = true;
      }
      return Promise.resolve({ ok: true, job_id: body.job_id });
    }
  }
  if (new URL(url).pathname === "/snapshot") {
    const runnerData = fixtureRunnerData(snapshot),
      runners = runnerData.runners;
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
      if (runnerJobs.get(name) === runner.repo_dir) runner.worker_pid = 1234;
    }
    runnerData.operations = runnerOperations.get(name) ?? [];
    runnerData.coordination = {
      available: true,
      enabled: exclusive.has(name),
      active_repo:
        runners.find((r) => r.repo_dir === runnerJobs.get(name))?.repo ?? null,
      paused:
        exclusive.has(name) && runnerJobs.has(name)
          ? runners
              .filter(
                (r) =>
                  r.repo_dir !== runnerJobs.get(name) &&
                  r.listener_pid !== null,
              )
              .map((r) => r.repo_dir)
          : [],
      waiting: [],
      error: null,
    };
    if (disabledPlugins.has(name))
      snapshot.plugins.runners = {
        version: 2,
        enabled: false,
        status: "disabled",
        ts: Date.now(),
        data: null,
        error: null,
      };
    snapshot.disk_revision = createHash("sha256")
      .update(
        JSON.stringify(snapshot.disk_scans, (key, value: unknown) =>
          key === "ts" ? undefined : value,
        ),
      )
      .digest("hex");
    return Promise.resolve(
      new URL(url).searchParams.get("disk_revision") === snapshot.disk_revision
        ? { ...snapshot, disk_scans: undefined }
        : snapshot,
    );
  }
  if (
    url.endsWith("/plugins/runners/actions/coordination") &&
    typeof body === "object" &&
    body &&
    "enable" in body
  ) {
    if (body.enable) exclusive.add(name);
    else exclusive.delete(name);
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
  if (
    url.includes("/plugins/runners/actions/") &&
    body &&
    typeof body === "object" &&
    "request_id" in body &&
    typeof body.request_id === "string"
  ) {
    const operation: RunnerOperation = {
      id: body.request_id,
      action: url.slice(url.lastIndexOf("/") + 1),
      request: Object.fromEntries(
        Object.entries(body).filter(([key]) => key !== "request_id"),
      ),
      status: "running",
      requested_at: Date.now(),
      finished_at: null,
      error: null,
    };
    runnerOperations.set(name, [
      ...(runnerOperations.get(name) ?? []),
      operation,
    ]);
    setTimeout(() => {
      operation.status = "completed";
      operation.finished_at = Date.now();
    }, 1500);
    return Promise.resolve({ ok: true, operation });
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
app.post<{ Body: { host: string } }>(
  "/__test/scan-complete",
  async (request) => {
    const name = request.body.host,
      job = scans.get(name);
    if (!job?.target) throw Error("No subtree job");
    const snapshot = makeSnapshot(
      config.hosts.findIndex((h) => h.name === name),
    );
    applyDirectories(name, snapshot);
    const root = snapshot.disk_scans.find((root) =>
      job.target?.startsWith(root.root + "/"),
    );
    if (!root) throw Error("Missing root");
    let node: ScanNode = root;
    for (const part of job.target.slice(node.root.length + 1).split("/")) {
      const next: ScanNode | undefined = node.children.find(
        (row) => row.root === part,
      );
      if (!next) throw Error("Missing directory");
      node = next;
    }
    node.children_status = "complete";
    node.children = [
      {
        ...node,
        root: node.root === "runners" ? "flowbit" : "_work",
        children: [],
        children_status: "unscanned",
      },
    ];
    const results = directoryResults.get(name) ?? new Map<string, ScanNode>();
    results.set(job.target, node);
    directoryResults.set(name, results);
    scans.set(name, {
      ...job,
      status: "completed",
      finished_at: Date.now(),
      current_root: null,
    });
    await monitor.poll();
    return { ok: true };
  },
);
app.post("/__test/reset", async () => {
  multiRepo = false;
  fanEnabled = false;
  fans.clear();
  await plugins.setEnabled("fan-control", false);
  scans.clear();
  directoryRules.clear();
  directoryResults.clear();
  exclusive.clear();
  runnerJobs.clear();
  runnerOperations.clear();
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
app.post<{ Body: { host: string; runner: string | null } }>(
  "/__test/runner-job",
  async (request) => {
    if (request.body.runner)
      runnerJobs.set(request.body.host, request.body.runner);
    else runnerJobs.delete(request.body.host);
    await monitor.poll();
    return { ok: true };
  },
);
app.post("/__test/fan-control", async () => {
  fanEnabled = true;
  await plugins.setEnabled("fan-control", true);
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
