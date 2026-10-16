import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import fastify from "fastify";
import { WebSocket, WebSocketServer } from "ws";

import { loadConfig, type HostConfig } from "./config.ts";
import { Store } from "./store.ts";

const execFileAsync = promisify(execFile);

async function main() {
  const configPath = process.argv[2] ?? "console.json";
  const config = loadConfig(configPath);
  const store = new Store(config.dbPath);
  const here = process.argv[1] ? dirname(process.argv[1]) : process.cwd();

  interface HostState {
    config: HostConfig;
    online: boolean;
    lastError: string | null;
    lastSnapshot: Record<string, unknown> | null;
    lastTs: number;
    history: Map<string, Array<{ ts: number; value: number }>>;
  }

  const hosts = new Map<string, HostState>();
  for (const host of config.hosts) {
    hosts.set(host.name, {
      config: host,
      online: false,
      lastError: null,
      lastSnapshot: null,
      lastTs: 0,
      history: new Map(),
      lastScanTs: null,
      ghRunners: null,
    });
  }

  const HISTORY_POINTS = 600; // ten minutes of 1s samples for live sparklines.

  function seriesKey(...parts: Array<string | number>): string {
    return parts.join(".");
  }

  function ingest(
    host: HostState,
    snapshot: Record<string, unknown>,
    ts: number,
  ): void {
    host.online = true;
    host.lastError = null;
    host.lastSnapshot = snapshot;
    host.lastTs = ts;

    const rows: Array<{
      host: string;
      key: string;
      ts: number;
      value: number;
    }> = [];
    const push = (key: string, value: number | undefined | null) => {
      if (typeof value === "number" && Number.isFinite(value)) {
        rows.push({ host: host.config.name, key, ts, value });
        const history = host.history.get(key) ?? [];
        history.push({ ts, value });
        if (history.length > HISTORY_POINTS)
          history.splice(0, history.length - HISTORY_POINTS);
        host.history.set(key, history);
      }
    };

    const sys = snapshot.sys as Record<string, any> | undefined;
    if (sys) {
      push("cpu.usage_pct", sys.cpu?.usage_pct);
      push("mem.used_bytes", sys.mem?.used_bytes);
      push("mem.available_bytes", sys.mem?.available_bytes);
      push("mem.swap_used_bytes", sys.mem?.swap_used_bytes);
      for (const disk of sys.disks ?? []) {
        if (disk.mount === "/System/Volumes/Data") {
          push("disk.data_available_bytes", disk.available_bytes);
        }
      }
    }
    const macmon = snapshot.macmon as Record<string, any> | undefined;
    if (macmon) {
      push("cpu.p_freq_mhz", macmon.p_cluster_mhz);
      push("cpu.e_freq_mhz", macmon.e_cluster_mhz);
      push("gpu.usage_pct", macmon.gpu_pct);
      push("power.cpu_w", macmon.cpu_power_w);
      push("power.package_w", macmon.package_power_w);
    }
    const thermal = snapshot.thermal as Record<string, any> | undefined;
    if (thermal) push("thermal.state", thermal.state);
    const fan = snapshot.fan as Record<string, any> | undefined;
    if (fan) {
      push("fan.rpm", fan.rpm);
      push("fan.temp_c", fan.temp);
    }
    const hostInfo = snapshot.host as Record<string, any> | undefined;
    if (hostInfo) {
      push("host.load_1m", hostInfo.load?.[0]);
    }

    store.insertSamples(rows);
  }

  async function pollOnce(host: HostState): Promise<void> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      // Unsigned node is denied LAN access from the launchd context (macOS
      // Local Network privacy); /usr/bin/curl is Apple-signed and allowed.
      const { stdout } = await execFileAsync(
        "/usr/bin/curl",
        [
          "-s",
          "-m",
          "4",
          "-H",
          `authorization: Bearer ${host.config.token}`,
          `${host.config.url}/snapshot`,
        ],
        { timeout: 4500, maxBuffer: 8 * 1024 * 1024 },
      );
      const snapshot = JSON.parse(stdout) as Record<string, unknown>;
      ingest(host, snapshot, Date.now());
    } catch (error) {
      host.online = false;
      const cause = (error as NodeJS.ErrnoException)?.cause as
        NodeJS.ErrnoException | undefined;
      host.lastError = cause
        ? `${error instanceof Error ? error.message : String(error)} (${cause.code ?? cause.message})`
        : error instanceof Error
          ? error.message
          : String(error);
    }
  }

  setInterval(() => {
    for (const host of hosts.values()) void pollOnce(host);
  }, 1000);

  setInterval(() => {
    try {
      store.downsampleAndPrune();
    } catch (error) {
      console.error("downsample failed:", error);
    }
  }, 10 * 60_000);

  function authorize(request: {
    headers: Record<string, string | string[] | undefined>;
  }): boolean {
    if (!config.uiToken) return true;
    const header = request.headers.authorization;
    const expected = `Bearer ${config.uiToken}`;
    return (
      header === expected || (typeof header === "string" && header === expected)
    );
  }

  async function refreshGhRunners(): Promise<void> {
    const token = config.githubToken;
    const repo = config.githubRepo;
    if (!token || !repo) return;
    try {
      const { stdout } = await execFileAsync(
        "/usr/bin/curl",
        [
          "-s",
          "-m",
          "8",
          "-H",
          `Authorization: Bearer ${token}`,
          "-H",
          "Accept: application/vnd.github+json",
          `https://api.github.com/repos/${repo}/actions/runners`,
        ],
        { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      );
      const parsed = JSON.parse(stdout) as {
        runners?: Array<Record<string, unknown>>;
      };
      if (!parsed.runners) return;
      for (const remote of parsed.runners) {
        const name = String(remote.name ?? "");
        const host = [...hosts.values()].find((h) =>
          name.endsWith(h.config.name),
        );
        if (host) {
          host.ghRunners = [
            ...(host.ghRunners ?? []).filter((r) => r.name !== name),
            remote,
          ];
        }
      }
    } catch {
      /* enrichment keeps the last good value */
    }
  }

  setInterval(() => {
    void refreshGhRunners();
  }, 30_000);
  void refreshGhRunners();

  const app = fastify({ logger: false });

  app.get("/api/state", async (request, reply) => {
    if (!authorize(request))
      return reply.code(401).send({ error: "unauthorized" });
    const payload = [...hosts.values()].map((host) => ({
      name: host.config.name,
      online: host.online,
      lastError: host.lastError,
      lastTs: host.lastTs,
      snapshot: host.lastSnapshot,
      history: Object.fromEntries(host.history),
      ghRunners: host.ghRunners,
    }));
    return { ts: Date.now(), hosts: payload };
  });

  app.get("/api/history", async (request, reply) => {
    if (!authorize(request))
      return reply.code(401).send({ error: "unauthorized" });
    const query = request.query as Record<string, string>;
    const host = query.host ?? "";
    const key = query.key ?? "";
    const windowMs = Math.min(
      Number(query.windowMs ?? 3_600_000),
      365 * 86_400_000,
    );
    if (!hosts.has(host) || !key)
      return reply.code(400).send({ error: "host and key required" });
    const toTs = Date.now();
    return {
      host,
      key,
      points: store.queryRange(host, key, toTs - windowMs, toTs),
    };
  });

  app.post("/api/runner/toggle", async (request, reply) => {
    if (!authorize(request))
      return reply.code(401).send({ error: "unauthorized" });
    const body = request.body as {
      host?: string;
      runner?: string;
      enable?: boolean;
    };
    if (!body.host || !body.runner || typeof body.enable !== "boolean") {
      return reply.code(400).send({ error: "host, runner, enable required" });
    }
    const hostState = hosts.get(body.host);
    if (!hostState) return reply.code(404).send({ error: "unknown host" });
    if (hostState.lastSnapshot) {
      const runnerEntry = (hostState.lastSnapshot.runners ?? []).find(
        (r: any) => r.agent_name === body.runner || r.repo_dir === body.runner,
      );
      if (runnerEntry?.worker_pid) {
        return reply.code(409).send({ error: "runner is running a job" });
      }
    }
    try {
      // Same Local-Network-privacy workaround as polling: curl is allowed.
      const payloadJson = JSON.stringify({
        runner: body.runner,
        enable: body.enable,
      });
      const { stdout, stderr } = await execFileAsync(
        "/usr/bin/curl",
        [
          "-s",
          "-m",
          "8",
          "-X",
          "POST",
          "-H",
          `authorization: Bearer ${hostState.config.token}`,
          "-H",
          "content-type: application/json",
          "-d",
          payloadJson,
          `${hostState.config.url}/runner-service`,
        ],
        { timeout: 10_000, maxBuffer: 1024 * 1024 },
      );
      let payload: { ok?: boolean; error?: string } = {};
      try {
        payload = JSON.parse(stdout || "{}") as {
          ok?: boolean;
          error?: string;
        };
      } catch {
        // Legacy agent replied with plain launchctl output; 2xx means success.
        payload = { ok: true };
      }
      if (!payload.ok) {
        return reply.code(502).send({
          error: payload.error ?? `agent error: ${stderr.slice(0, 120)}`,
        });
      }
      return { ok: true };
    } catch (error) {
      const cause = (error as NodeJS.ErrnoException)?.cause as
        NodeJS.ErrnoException | undefined;
      console.error(
        `runner toggle failed for ${body.host}: ${error instanceof Error ? error.message : String(error)}` +
          (cause ? ` cause=${cause.code ?? cause.message}` : ""),
      );
      return reply.code(502).send({
        error:
          error instanceof Error
            ? `${error.message}${cause ? ` (${cause.code ?? cause.message})` : ""}`
            : String(error),
      });
    }
  });

  app.post("/api/disk/rescan", async (request, reply) => {
    if (!authorize(request))
      return reply.code(401).send({ error: "unauthorized" });
    const body = request.body as { host?: string };
    if (!body.host || !hosts.has(body.host)) {
      return reply.code(400).send({ error: "valid host required" });
    }
    const hostState = hosts.get(body.host)!;
    try {
      const { stdout } = await execFileAsync(
        "/usr/bin/curl",
        [
          "-s",
          "-m",
          "5",
          "-X",
          "POST",
          "-H",
          `authorization: Bearer ${hostState.config.token}`,
          `${hostState.config.url}/rescan-disk`,
        ],
        { timeout: 8_000, maxBuffer: 1024 },
      );
      const payload = JSON.parse(stdout || "{}") as { ok?: boolean };
      return { ok: payload.ok === true };
    } catch (error) {
      return reply.code(502).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get("/api/config", async (request, reply) => {
    if (!authorize(request))
      return reply.code(401).send({ error: "unauthorized" });
    return {
      version: "0.1.0",
      hosts: config.hosts.map(({ name, url }) => ({ name, url })),
    };
  });

  const webDir = join(here, "web");

  const contentTypes: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
  };

  async function serveStatic(
    reply: any,
    absolutePath: string,
    fallbackPath?: string,
  ): Promise<void> {
    for (const candidate of [absolutePath, fallbackPath].filter(
      Boolean,
    ) as string[]) {
      try {
        const body = readFileSync(candidate);
        const type =
          contentTypes[candidate.slice(candidate.lastIndexOf("."))] ??
          "application/octet-stream";
        reply.header("content-type", type);
        return reply.send(body);
      } catch {
        /* try the next candidate */
      }
    }
    reply.code(404).send({ error: "not found" });
  }

  app.get("/", async (_request, reply) => {
    reply.header("cache-control", "no-cache");
    await serveStatic(reply, join(webDir, "index.html"));
  });
  app.get("/app.js", async (_request, reply) => {
    await serveStatic(reply, join(webDir, "app.js"));
  });
  app.get("/app.:hash.js", async (request, reply) => {
    await serveStatic(
      reply,
      join(webDir, `app.${(request.params as any).hash}.js`),
    );
  });
  app.get("/styles.css", async (_request, reply) => {
    await serveStatic(reply, join(webDir, "styles.css"));
  });

  await app.listen({
    port: Number(config.bind.split(":")[1] ?? 9100),
    host: config.bind.split(":")[0],
  });

  const wsServer = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();
  wsServer.on("connection", (socket, request) => {
    if (config.uiToken) {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.searchParams.get("token") !== config.uiToken) {
        socket.close(4001, "unauthorized");
        return;
      }
    }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  setInterval(() => {
    if (sockets.size === 0) return;
    const payload = JSON.stringify({
      ts: Date.now(),
      hosts: [...hosts.values()].map((host) => ({
        name: host.config.name,
        online: host.online,
        lastError: host.lastError,
        lastTs: host.lastTs,
        snapshot: host.lastSnapshot,
        history: Object.fromEntries(host.history),
        ghRunners: host.ghRunners,
      })),
    });
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    }
  }, 1000);

  (
    app.server as unknown as {
      on: (event: string, listener: (...args: never[]) => void) => void;
    }
  ).on("upgrade", ((
    request: import("node:http").IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
  ) => {
    wsServer.handleUpgrade(request, socket, head, (ws) =>
      wsServer.emit("connection", ws, request),
    );
  }) as unknown as (...args: never[]) => void);

  console.log(
    `mini-fleet console listening on ${config.bind}, web: ${join(here, "web")}`,
  );
}
void main();
