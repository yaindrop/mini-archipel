import type { ConsoleConfig } from "../src/config.ts";
import type { Host, Snapshot, ScanNode } from "../src/contracts.ts";
import { AgentDataSchema } from "../src/plugins/runners/contracts.ts";
import { EnvelopeSchema } from "../src/plugins/contracts.ts";
export const TOKEN = "test-console-token-only-not-a-real-secret";
export const config: ConsoleConfig = {
  bind: "127.0.0.1:19101",
  uiToken: TOKEN,
  dbPath: ":memory:",
  plugins: { runners: { enabled: true, options: {} } },
  hosts: ["yd-mini", "yd-mini-2", "yd-mbp-tart", "yd-mbp-tart-2"].map(
    (name, index) => ({
      name,
      kind: index < 2 ? "physical" : "virtual",
      identity: index < 2 ? "M6 Mac Mini" : "Tart on M4 Max MacBook",
      url: `http://${name}.test:9101`,
      token: "test-agent-token",
    }),
  ),
};
function scan(
  root: string,
  bytes: number,
  children: ScanNode[] = [],
  cls = "user",
): ScanNode {
  return {
    root,
    bytes,
    children,
    class: cls,
    ts: Date.now(),
    duration_ms: 2300,
    partial: false,
    children_status: root.toLowerCase().endsWith(".app")
      ? "excluded"
      : "complete",
    error: null,
  };
}
export function makeSnapshot(index = 0): Snapshot {
  const now = Date.now(),
    virtual = index >= 2;
  return {
    agent: { version: "0.1.0", started_at: now - 3600_000, ts: now },
    disk_scan: {
      id: 1,
      status: "completed",
      requested_at: now - 2500,
      started_at: now - 2300,
      finished_at: now,
      current_root: null,
      target: null,
      error: null,
    },
    host: {
      name: config.hosts[index]?.name ?? "yd-mini",
      model: virtual ? "VirtualMac2,1" : "Mac18,5",
      os: "macOS 27.0.1",
      arch: "aarch64",
      cores: virtual ? 6 : 12,
      memory_bytes: 16 * 2 ** 30,
      uptime_s: virtual ? 37800 : 200000,
      load: [0.6, 0.7, 0.8],
      ts: now,
    },
    sys: {
      cpu: {
        usage_pct: [12.4, 5.8, 18.2, 8.6][index] ?? 4,
        cores: Array.from(
          { length: virtual ? 6 : 12 },
          (_, i) => 2 + ((i * 7) % 30),
        ),
      },
      mem: {
        total_bytes: 16 * 2 ** 30,
        used_bytes: (5.2 + index) * 2 ** 30,
        available_bytes: (10.8 - index) * 2 ** 30,
        swap_total_bytes: 0,
        swap_used_bytes: 0,
      },
      disks: [
        {
          mount: "/System/Volumes/Data",
          fs: "APFS",
          total_bytes: 228 * 2 ** 30,
          available_bytes: (160 + index * 10) * 2 ** 30,
        },
      ],
      procs: [
        {
          pid: 100,
          name: "Runner.Listener",
          cpu_pct: 1.4,
          mem_bytes: 140 * 2 ** 20,
        },
        {
          pid: 200,
          name: "mini-archipel-agent",
          cpu_pct: 1.1,
          mem_bytes: 20 * 2 ** 20,
        },
        { pid: 300, name: "node", cpu_pct: 3.8, mem_bytes: 260 * 2 ** 20 },
        ...(index === 3
          ? [
              {
                pid: 999,
                name: "Runner.Worker",
                cpu_pct: 20,
                mem_bytes: 140 * 2 ** 20,
              },
            ]
          : []),
      ],
      ts: now,
    },
    macmon: virtual
      ? null
      : {
          e_cluster_mhz: 1296,
          e_cluster_pct: 8,
          p_cluster_mhz: 1440,
          p_cluster_pct: 13,
          gpu_mhz: 502,
          gpu_pct: 3.2,
          cpu_power_w: 2.5,
          gpu_power_w: 0.3,
          package_power_w: 6.2,
          ts: now,
        },
    fan: virtual
      ? null
      : {
          ok: true,
          have_temp: true,
          temp: 34.7 + index,
          rpm: index ? 0 : 1000,
          target: index ? 0 : 1000,
          forced: false,
          paused: false,
        },
    thermal: { state: 0, ts: now },
    disk_scans: [
      scan(
        `/Users/${config.hosts[index]?.name ?? "yd-mini"}`,
        30 * 2 ** 30 + 2 ** 20,
        [
          { ...scan("runners", 18 * 2 ** 30), children_status: "unscanned" },
          scan(
            "Library",
            6 * 2 ** 30,
            [
              scan(
                "Caches",
                3 * 2 ** 30,
                [scan("Chrome", 3 * 2 ** 30, [], "reclaimable")],
                "reclaimable",
              ),
              scan(
                "Application Support",
                3 * 2 ** 30,
                [scan("Code", 3 * 2 ** 30, [], "library")],
                "library",
              ),
            ],
            "library",
          ),
          scan(".rustup", 3 * 2 ** 30, [], "toolchain"),
          {
            ...scan("Protected", 0),
            partial: true,
            children_status: "unreadable",
            error: "Operation not permitted",
          },
          scan("Empty", 0),
          scan(
            "Applications",
            2 * 2 ** 30,
            [
              scan("Tool.app", 1 * 2 ** 30, [], "apps"),
              scan("Other.app", 1 * 2 ** 30, [], "apps"),
            ],
            "apps",
          ),
          scan(
            ".cache",
            1 * 2 ** 30,
            [scan("uv", 1 * 2 ** 30, [], "reclaimable")],
            "reclaimable",
          ),
          scan(
            ".local",
            1 * 2 ** 20,
            [
              scan(
                "share",
                2 ** 19,
                [scan("mini-archipel", 2 ** 19, [], "appdata")],
                "appdata",
              ),
              scan(
                "state",
                2 ** 19,
                [scan("mini-archipel", 2 ** 19, [], "appdata")],
                "appdata",
              ),
            ],
            "user",
          ),
        ],
      ),
      scan("/", 90 * 2 ** 30 + 4 * 2 ** 20, [
        scan(
          "System",
          70 * 2 ** 30,
          [
            scan(
              "Library",
              70 * 2 ** 30,
              [scan("Frameworks", 70 * 2 ** 30, [], "system")],
              "system",
            ),
          ],
          "system",
        ),
        scan("Users", 20 * 2 ** 30, [scan("yd-mini", 20 * 2 ** 30)]),
        scan(
          "private",
          1 * 2 ** 20,
          [
            scan(
              "var",
              1 * 2 ** 20,
              [scan("db", 1 * 2 ** 20, [], "system")],
              "system",
            ),
          ],
          "system",
        ),
        scan(
          "Library",
          1 * 2 ** 20,
          [
            scan("Updates", 3 * 2 ** 18, [], "library"),
            scan(
              "Caches",
              0,
              [scan("Desktop Pictures", 0, [], "reclaimable")],
              "reclaimable",
            ),
            scan(
              "Application Support",
              2 ** 18,
              [scan("Apple", 2 ** 18, [], "library")],
              "library",
            ),
          ],
          "library",
        ),
        scan(
          "usr",
          1 * 2 ** 20,
          [scan("lib", 1 * 2 ** 20, [], "system")],
          "system",
        ),
        scan(
          "opt",
          1 * 2 ** 20,
          [
            scan(
              "homebrew",
              1 * 2 ** 20,
              [scan("Cellar", 1 * 2 ** 20, [], "reclaimable")],
              "reclaimable",
            ),
          ],
          "reclaimable",
        ),
      ]),
    ],
    plugins: {
      runners: {
        version: 2,
        enabled: true,
        status: "ready",
        ts: now,
        error: null,
        data: {
          interval_ms: 5000,
          control_allowed: true,
          coordination: {
            available: true,
            enabled: false,
            active_repo: null,
            paused: [],
            waiting: [],
            error: null,
          },
          runners: [
            {
              repo_dir: "flowbit",
              repo: "yaindrop/flowbit",
              agent_name: `flowbit-${config.hosts[index]?.name ?? "yd-mini"}`,
              agent_id: 29 + index,
              labels: [],
              work_folder: "_work",
              listener_pid: 100,
              worker_pid: index === 3 ? 999 : null,
              work_bytes: (18 + index) * 2 ** 30,
              diag_bytes: 3 * 2 ** 20,
              diag_latest: "Runner_20261017-040000-utc.log",
              run:
                index === 0
                  ? {
                      schema: 1,
                      phase: "summary",
                      conclusion: "passed",
                      sha: "abcdef1234567890",
                      pr: 12,
                      run_id: "99",
                      run_attempt: 1,
                      requester: "ada",
                      shared_ref: "fedcba0987654321fedcba0987654321fedcba09",
                      env_ok: true,
                      failure: null,
                      diagnostics: null,
                    }
                  : null,
              ts: now,
            },
          ],
        },
      },
    },
  };
}
export function makeHost(index = 0): Host {
  const snapshot = makeSnapshot(index),
    now = Date.now();
  return {
    name: config.hosts[index]?.name ?? "yd-mini",
    kind: config.hosts[index]?.kind ?? "physical",
    identity: config.hosts[index]?.identity ?? "",
    online: true,
    lastError: null,
    lastTs: now,
    snapshot,
    history: Object.fromEntries(
      ["cpu.usage_pct", "mem.used_bytes", "fan.rpm", "fan.temp_c"].map(
        (key) => [
          key,
          Array.from({ length: 120 }, (_, i) => ({
            ts: now - (119 - i) * 5000,
            value:
              key === "cpu.usage_pct"
                ? 10 +
                  index * 2 +
                  Math.sin(i / 8) * 4 +
                  (i % 25 < 3 ? index * 3 : 0)
                : key === "mem.used_bytes"
                  ? (5.2 + index + Math.sin(i / 20) * 0.1) * 2 ** 30
                  : key === "fan.rpm"
                    ? 1000
                    : 35 + Math.sin(i / 12),
          })),
        ],
      ),
    ),
  };
}

export function fixtureRunnerData(snapshot: Snapshot) {
  const envelope = EnvelopeSchema.parse(snapshot.plugins.runners);
  const data = AgentDataSchema.parse(envelope.data);
  snapshot.plugins.runners = { ...envelope, data };
  return data;
}
