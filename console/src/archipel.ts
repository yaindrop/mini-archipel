import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ConsoleConfig } from "./config.ts";
import {
  SnapshotUpdateSchema,
  type Snapshot,
  type Archipel,
} from "./contracts.ts";
import { restoreSnapshot } from "./archipel-wire.ts";
import { Store, type Sample } from "./store.ts";
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
  signal?: AbortSignal,
) => Promise<unknown>;
/** curl preserves macOS Local Network permission. Credentials travel over stdin, never argv or error text. */
export const curlTransport: Transport = async (
  url,
  token,
  body,
  method = "POST",
  signal,
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
    ...(signal ? { signal } : {}),
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
export class ArchipelMonitor {
  private readonly hosts: Archipel["hosts"];
  private readonly polling = new Map<string, Promise<void>>();
  private abort = new AbortController();
  private timers: ReturnType<typeof setInterval>[] = [];
  private historyError: string | null = null;
  private stopped = false;
  private pendingSamples: Sample[] = [];
  private readonly sourceTimestamps = new Map<string, number>();
  private pendingWrite: Promise<void> | null = null;
  private loadingHistory: Promise<void> | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private dropped = 0;
  private lastFlush = 0;
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
      history: Object.fromEntries(METRIC_KEYS.map((key) => [key, []])),
    }));
  }
  state(now = Date.now()): Archipel {
    return {
      ts: now,
      historyError: this.historyError,
      historyDropped: this.dropped,
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
    await this.flushHistory();
  }
  private async restoreHistory(): Promise<void> {
    try {
      await Promise.all(
        this.hosts.flatMap((host) =>
          METRIC_KEYS.map(async (key) => {
            const latest = await this.store.latestTimestamp(host.name, key);
            this.sourceTimestamps.set(`${host.name}:${key}`, latest);
            const points = await this.store.queryRange(
              host.name,
              key,
              Date.now() - 600_000,
              Date.now(),
            );
            host.history[key] = [
              ...new Map(
                [...points, ...(host.history[key] ?? [])].map((point) => [
                  point.ts,
                  point,
                ]),
              ).values(),
            ]
              .sort((a, b) => a.ts - b.ts)
              .slice(-600);
          }),
        ),
      );
    } catch {
      this.historyError = /*i18n*/ "历史记录暂时无法读取，实时监测仍在运行";
    }
  }
  private enqueue(samples: Sample[]): void {
    this.pendingSamples.push(...samples);
    if (this.pendingSamples.length > 3600) {
      this.historyError = /*i18n*/ "历史缓冲已满，部分样本未保存";
      this.dropped += this.pendingSamples.length - 3600;
      this.pendingSamples = this.pendingSamples.slice(-3600);
    }
    if (!this.flushTimer && !this.stopped)
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        void this.flushHistory(true);
      }, 5000);
  }
  private async flushHistory(force = false): Promise<void> {
    if (this.pendingWrite) {
      await this.pendingWrite;
      return;
    }
    if (!this.pendingSamples.length) return;
    if (!force && Date.now() - this.lastFlush < 5000) return;
    this.lastFlush = Date.now();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    const batch = this.pendingSamples.splice(0);
    this.pendingWrite = (async () => {
      try {
        await this.store.insertSamples(batch);
        this.historyError = this.dropped
          ? /*i18n*/ "历史缓冲已满，部分样本未保存"
          : null;
      } catch {
        this.pendingSamples = [...batch, ...this.pendingSamples];
        this.historyError = /*i18n*/ "历史记录暂时无法保存，实时监测仍在运行";
        this.enqueue([]);
      }
    })();
    await this.pendingWrite;
    this.pendingWrite = null;
  }
  pollHost(name: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const existing = this.polling.get(name);
    if (existing) return existing;
    const pending = this.collectHost(name).finally(() => {
      this.polling.delete(name);
    });
    this.polling.set(name, pending);
    return pending;
  }
  private async collectHost(name: string): Promise<void> {
    const host = this.hosts.find((h) => h.name === name),
      config = this.config.hosts.find((h) => h.name === name);
    if (!host || !config) return;
    try {
      if (this.loadingHistory) await this.loadingHistory;
      if (this.stopped) return;
      const revision = host.snapshot?.disk_revision;
      const snapshot = restoreSnapshot(
        SnapshotUpdateSchema.parse(
          await this.transport(
            `${config.url}/snapshot${revision ? `?disk_revision=${encodeURIComponent(revision)}` : ""}`,
            config.token,
            undefined,
            undefined,
            this.abort.signal,
          ),
        ),
        host.snapshot,
      );
      const ts = Date.now();
      if (this.abort.signal.aborted) return;
      const samples = sampleValues(snapshot).flatMap(([key, value]) => {
        const source = key.startsWith("fan.")
          ? snapshot.fan
          : key.startsWith("thermal.")
            ? snapshot.thermal
            : key.startsWith("host.")
              ? snapshot.host
              : /freq|gpu\.|power\./.test(key)
                ? snapshot.macmon
                : snapshot.sys;
        const at = source?.ts;
        const limit = key.startsWith("host.")
          ? 180_000
          : key.startsWith("thermal.")
            ? 30_000
            : 10_000;
        const previous = this.sourceTimestamps.get(`${name}:${key}`) ?? 0;
        if (
          !at ||
          at <= previous ||
          at > ts + 5000 ||
          ts - at > limit ||
          ("error" in source && source.error)
        )
          return [];
        return [{ host: name, key, value, ts: at }];
      });
      for (const { key, value, ts: at } of samples) {
        this.sourceTimestamps.set(`${name}:${key}`, at);
        const history = host.history[key] ?? [];
        history.push({
          ts: at,
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
      this.enqueue(samples);
    } catch (error) {
      if (this.stopped) return;
      host.online = false;
      host.lastError =
        error instanceof UpstreamError
          ? error.message
          : /*i18n*/ "节点数据校验失败";
    }
  }
  start(): void {
    if (this.timers.length) return;
    this.stopped = false;
    this.abort = new AbortController();
    this.loadingHistory = this.restoreHistory();
    void this.poll();
    this.timers = [
      setInterval(() => {
        void this.poll();
      }, 1000),
      setInterval(() => {
        void this.store.downsampleAndPrune().catch(() => {
          this.historyError = /*i18n*/ "历史归档暂时失败，实时监测仍在运行";
        });
      }, 600_000),
    ];
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    if (this.flushTimer) clearTimeout(this.flushTimer);
    await Promise.allSettled([...this.polling.values(), this.loadingHistory]);
    if (this.pendingWrite) await this.pendingWrite;
    await this.flushHistory(true);
  }
  async command(
    name: string,
    path: string,
    body?: unknown,
    method: "POST" | "PUT" = "POST",
  ): Promise<unknown> {
    const config = this.config.hosts.find((h) => h.name === name);
    if (!config) throw new UpstreamError(404, /*i18n*/ "节点不存在");
    return this.transport(
      `${config.url}/${path}`,
      config.token,
      body,
      method,
      this.abort.signal,
    );
  }
}
