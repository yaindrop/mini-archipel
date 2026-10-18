import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ConsoleConfig } from "./config.ts";
import { SnapshotSchema, type Snapshot, type Fleet } from "./contracts.ts";
import { Store } from "./store.ts";
import { METRIC_KEYS } from "./domain.ts";
const exec = promisify(execFile);
export class UpstreamError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export type Transport = (
  url: string,
  token: string,
  body?: unknown,
  method?: "POST" | "PUT",
) => Promise<unknown>;
/** curl preserves macOS Local Network permission. Credentials travel over stdin, never argv or error text. */
export const curlTransport: Transport = async (
  url,
  token,
  body,
  method = "POST",
) => {
  const target = new URL(url);
  const local =
    target.protocol === "http:" ||
    target.hostname.endsWith(".local") ||
    /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(
      target.hostname,
    );
  const args = [
    "--config",
    "-",
    "--silent",
    "--show-error",
    "--max-time",
    "35",
    "--write-out",
    "\n%{http_code}",
    ...(local ? ["--noproxy", "*"] : []),
    "--url",
    url,
  ];
  const call = exec("/usr/bin/curl", args, {
    timeout: 38_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  call.child.stdin?.end(
    `header = ${JSON.stringify(`Authorization: Bearer ${token}`)}\nheader = "Content-Type: application/json"\n${body === undefined ? "" : `request = "${method}"\ndata = ${JSON.stringify(JSON.stringify(body))}\n`}`,
  );
  let stdout: string;
  try {
    ({ stdout } = await call);
  } catch {
    throw new UpstreamError(502, /*i18n*/ "无法连接节点，或请求已超时");
  }
  const index = stdout.lastIndexOf("\n");
  const status = Number(stdout.slice(index + 1)),
    text = stdout.slice(0, index);
  if (status < 200 || status >= 300)
    throw new UpstreamError(
      status >= 400 && status < 600 ? status : 502,
      `节点请求失败（HTTP ${String(status)}）`,
    );
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new UpstreamError(502, /*i18n*/ "节点返回了无效数据");
  }
};
export function sampleValues(snapshot: Snapshot): [string, number][] {
  const values: [string, number | null | undefined][] = [
    ["cpu.usage_pct", snapshot.sys?.cpu.usage_pct],
    ["mem.used_bytes", snapshot.sys?.mem.used_bytes],
    ["mem.available_bytes", snapshot.sys?.mem.available_bytes],
    ["mem.swap_used_bytes", snapshot.sys?.mem.swap_used_bytes],
    [
      "disk.data_available_bytes",
      snapshot.sys?.disks.find((d) => d.mount === "/System/Volumes/Data")
        ?.available_bytes,
    ],
    ["cpu.p_freq_mhz", snapshot.macmon?.p_cluster_mhz],
    ["cpu.e_freq_mhz", snapshot.macmon?.e_cluster_mhz],
    ["gpu.usage_pct", snapshot.macmon?.gpu_pct],
    ["power.cpu_w", snapshot.macmon?.cpu_power_w],
    ["power.package_w", snapshot.macmon?.package_power_w],
    ["thermal.state", snapshot.thermal?.state],
    ["fan.rpm", snapshot.fan?.rpm],
    [
      "fan.temp_c",
      snapshot.fan?.have_temp === false ? undefined : snapshot.fan?.temp,
    ],
    ["host.load_1m", snapshot.host?.load[0]],
  ];
  return values.filter(
    (row): row is [string, number] =>
      typeof row[1] === "number" && Number.isFinite(row[1]),
  );
}
export class FleetMonitor {
  private readonly hosts: Fleet["hosts"];
  private readonly polling = new Set<string>();
  private timers: ReturnType<typeof setInterval>[] = [];
  readonly config: ConsoleConfig;
  private readonly store: Store;
  private readonly transport: Transport;
  constructor(
    config: ConsoleConfig,
    store: Store,
    transport: Transport = curlTransport,
  ) {
    this.config = config;
    this.store = store;
    this.transport = transport;
    this.hosts = config.hosts.map((h) => ({
      name: h.name,
      kind: h.kind,
      identity: h.identity,
      online: false,
      lastError: null,
      lastTs: 0,
      snapshot: null,
      history: Object.fromEntries(
        METRIC_KEYS.map((key) => [
          key,
          store.queryRange(h.name, key, Date.now() - 600_000, Date.now()),
        ]),
      ),
    }));
  }
  state(now = Date.now()): Fleet {
    return {
      ts: now,
      plugins: {},
      hosts: this.hosts.map((host) => ({
        ...host,
        history: Object.fromEntries(
          Object.entries(host.history).map(([key, points]) => [
            key,
            points.filter(
              (_, index) =>
                index % Math.max(1, Math.ceil(points.length / 120)) === 0 ||
                index === points.length - 1,
            ),
          ]),
        ),
      })),
    };
  }
  async poll(): Promise<void> {
    await Promise.all(this.config.hosts.map((h) => this.pollHost(h.name)));
  }
  async pollHost(name: string): Promise<void> {
    if (this.polling.has(name)) return;
    const host = this.hosts.find((h) => h.name === name),
      config = this.config.hosts.find((h) => h.name === name);
    if (!host || !config) return;
    this.polling.add(name);
    try {
      const snapshot = SnapshotSchema.parse(
        await this.transport(`${config.url}/snapshot`, config.token),
      );
      const ts = Date.now();
      const samples = sampleValues(snapshot);
      this.store.insertSamples(
        samples.map(([key, value]) => ({
          host: name,
          key,
          ts,
          value,
        })),
      );
      for (const [key, value] of samples) {
        const history = host.history[key] ?? [];
        history.push({
          ts,
          value,
        });
        host.history[key] = history
          .filter((p) => p.ts >= ts - 600_000)
          .slice(-600);
      }
      Object.assign(host, {
        online: true,
        lastError: null,
        lastTs: ts,
        snapshot,
      });
    } catch (error) {
      host.online = false;
      host.lastError =
        error instanceof UpstreamError
          ? error.message
          : /*i18n*/ "节点数据校验失败";
    } finally {
      this.polling.delete(name);
    }
  }
  start(): void {
    void this.poll();
    this.timers = [
      setInterval(() => {
        void this.poll();
      }, 1000),
      setInterval(() => {
        try {
          this.store.downsampleAndPrune();
        } catch {
          console.error("history retention failed");
        }
      }, 600_000),
    ];
  }
  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }
  async command(
    name: string,
    path: string,
    body?: unknown,
    method: "POST" | "PUT" = "POST",
  ): Promise<unknown> {
    const config = this.config.hosts.find((h) => h.name === name);
    if (!config) throw new UpstreamError(404, /*i18n*/ "节点不存在");
    return this.transport(`${config.url}/${path}`, config.token, body, method);
  }
}
