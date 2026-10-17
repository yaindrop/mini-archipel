import { afterEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { serverPlugins } from "../src/plugins/catalog.server.ts";
import { createApp } from "../src/app.ts";
import { config, TOKEN, makeSnapshot, fixtureRunnerData } from "./fixtures.ts";
import { UpstreamError, type Transport } from "../src/fleet.ts";
const dir = mkdtempSync(join(tmpdir(), "fleet-web-"));
writeFileSync(join(dir, "index.html"), "<h1>workbench</h1>");
writeFileSync(join(dir, "asset.css"), "body{}");
const instances: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((x) => x.app.close()));
  vi.useRealTimers();
});
function setup(
  transport: Transport = (url) =>
    Promise.resolve(
      url.endsWith("/snapshot")
        ? makeSnapshot(config.hosts.findIndex((h) => url.startsWith(h.url)))
        : { ok: true },
    ),
) {
  const x = createApp(config, {
    webDir: dir,
    transport,
    startPolling: false,
    plugins: serverPlugins,
  });
  instances.push(x);
  return x;
}
const auth = { authorization: `Bearer ${TOKEN}` };
async function session(app: ReturnType<typeof createApp>["app"]) {
  const r = await app.inject({
    method: "POST",
    url: "/api/session",
    payload: { token: TOKEN },
  });
  return String(r.headers["set-cookie"]).split(";")[0] ?? "";
}
describe("authenticated console boundary", () => {
  it("does not disclose state or config before authentication", async () => {
    const { app } = setup();
    for (const url of [
      "/api/state",
      "/api/config",
      "/api/history?host=yd-mini&key=cpu.usage_pct",
    ])
      expect((await app.inject({ url })).statusCode).toBe(401);
    expect(
      (await app.inject({ url: `/api/state?token=${TOKEN}` })).statusCode,
    ).toBe(401);
    expect((await app.inject({ url: "/api/session" })).json()).toEqual({
      authenticated: false,
      required: true,
    });
  });
  it("exchanges a correct token for HttpOnly cookies, rejects bad tokens, and clears logout", async () => {
    const { app } = setup();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/session",
          payload: { token: "wrong" },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: "POST", url: "/api/session", payload: {} }))
        .statusCode,
    ).toBe(401);
    const r = await app.inject({
      method: "POST",
      url: "/api/session",
      payload: { token: TOKEN },
    });
    expect(r.headers["set-cookie"]).toContain("HttpOnly");
    expect(r.headers["set-cookie"]).toContain("SameSite=Strict");
    expect(r.headers["set-cookie"]).not.toContain(TOKEN);
    const cookie = await session(app);
    expect(
      (await app.inject({ url: "/api/state", headers: { cookie } })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: "/api/session", headers: { cookie } })).json(),
    ).toEqual({ authenticated: true, required: true });
    expect(
      (
        await app.inject({
          url: "/api/state",
          headers: { cookie: cookie + "bad" },
        })
      ).statusCode,
    ).toBe(401);
    const logout = await app.inject({
      method: "DELETE",
      url: "/api/session",
      headers: { cookie },
    });
    expect(logout.headers["set-cookie"]).toContain("Max-Age=0");
  });
  it("expires sessions and rejects cross-site mutations", async () => {
    const { app } = setup();
    const cookie = await session(app);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/disk/rescan",
          headers: { ...auth, origin: "https://evil.test" },
          payload: { host: "yd-mini" },
        })
      ).statusCode,
    ).toBe(403);
    for (const origin of ["null", "not-a-url", "file://localhost"])
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/disk/rescan",
            headers: { ...auth, origin },
            payload: { host: "yd-mini" },
          })
        ).statusCode,
      ).toBe(403);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 9 * 3600_000);
    expect(
      (await app.inject({ url: "/api/state", headers: { cookie } })).statusCode,
    ).toBe(401);
  });
  it("serves hashed assets, direct application routes and explicit missing API errors", async () => {
    const { app } = setup();
    const page = await app.inject({ url: "/nodes/yd-mini" });
    expect(page.statusCode).toBe(200);
    expect((await app.inject({ method: "HEAD", url: "/" })).statusCode).toBe(
      200,
    );
    expect((await app.inject({ url: "/nodes/yd-mini.local" })).statusCode).toBe(
      200,
    );
    expect(page.headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
    expect(
      (await app.inject({ url: "/asset.css" })).headers["content-type"],
    ).toContain("text/css");
    expect((await app.inject({ url: "/missing.js" })).statusCode).toBe(404);
    expect(
      (await app.inject({ url: "/api/nope", headers: auth })).statusCode,
    ).toBe(404);
  });
  it("returns public configuration without credentials", async () => {
    const { app } = setup();
    const r = await app.inject({ url: "/api/config", headers: auth });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain("test-agent-token");
    expect(r.body).not.toContain(TOKEN);
  });
});
describe("safe mutations and query inputs", () => {
  it("rechecks local Worker state even if the client believed the runner idle", async () => {
    const calls: string[] = [];
    const { app, monitor } = setup((url) => {
      calls.push(url);
      const s = makeSnapshot(0);
      const runner = fixtureRunnerData(s).runners[0];
      if (!runner) throw Error("fixture");
      runner.worker_pid = 999;
      return Promise.resolve(s);
    });
    await monitor.poll();
    const r = await app.inject({
      method: "POST",
      url: "/api/plugins/runners/actions/toggle",
      headers: auth,
      payload: {
        host: "yd-mini",
        repo: "yaindrop/flowbit",
        runner: "flowbit",
        enable: false,
      },
    });
    expect(r.statusCode).toBe(409);
    expect(
      calls.some((p) => p.endsWith("/plugins/runners/actions/toggle")),
    ).toBe(false);
  });
  it("does not send commands to missing runners or stale hosts", async () => {
    const { app, monitor } = setup();
    await monitor.poll();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/plugins/runners/actions/toggle",
          headers: auth,
          payload: {
            host: "yd-mini",
            repo: "yaindrop/flowbit",
            runner: "missing",
            enable: false,
          },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/plugins/runners/actions/toggle",
          headers: auth,
          payload: {
            host: "missing",
            repo: "yaindrop/flowbit",
            runner: "missing",
            enable: false,
          },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/plugins/runners/actions/toggle",
          headers: auth,
          payload: { host: "yd-mini", enable: "false" },
        })
      ).statusCode,
    ).toBe(400);
  });
  it("forwards valid commands and propagates upstream failures instead of showing false success", async () => {
    let fail = false;
    const transport = vi.fn<Transport>((url) => {
      if (url.endsWith("/snapshot")) return Promise.resolve(makeSnapshot());
      if (fail)
        return Promise.reject(new UpstreamError(503, "节点服务暂不可用"));
      return Promise.resolve({ ok: true });
    });
    const { app, monitor } = setup(transport);
    await monitor.poll();
    const payload = {
      host: "yd-mini",
      repo: "yaindrop/flowbit",
      runner: "flowbit",
      enable: false,
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/plugins/runners/actions/toggle",
          headers: auth,
          payload,
        })
      ).statusCode,
    ).toBe(200);
    expect(transport).toHaveBeenCalledWith(
      "http://yd-mini.test:9101/plugins/runners/actions/toggle",
      "test-agent-token",
      { repo: "yaindrop/flowbit", runner: "flowbit", enable: false },
      "POST",
    );
    fail = true;
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/plugins/runners/actions/toggle",
          headers: auth,
          payload,
        })
      ).statusCode,
    ).toBe(503);
  });
  it("returns 409 for unreachable nodes and validates rescan targets", async () => {
    const { app } = setup(() =>
      Promise.reject(new UpstreamError(502, "不可达")),
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/plugins/runners/actions/toggle",
          headers: auth,
          payload: {
            host: "yd-mini",
            repo: "yaindrop/flowbit",
            runner: "flowbit",
            enable: false,
          },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/disk/rescan",
          headers: auth,
          payload: { host: "missing" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/disk/rescan",
          headers: auth,
          payload: { host: "yd-mini" },
        })
      ).statusCode,
    ).toBe(409);
  });
  it("acknowledges an actual rescan and validates historical windows and metric names", async () => {
    const { app, monitor } = setup();
    await monitor.poll();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/disk/cancel",
          headers: auth,
          payload: { host: "yd-mini", id: 1 },
        })
      ).json(),
    ).toEqual({ ok: true });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/disk/cancel",
          headers: auth,
          payload: { host: "yd-mini", id: -1 },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/disk/rescan",
          headers: auth,
          payload: { host: "yd-mini" },
        })
      ).json(),
    ).toEqual({ ok: true });
    for (const suffix of [
      "windowMs=NaN",
      "windowMs=-1",
      "windowMs=Infinity",
      "windowMs=999999999999999",
      "key=unregistered",
    ])
      expect(
        (
          await app.inject({
            url: `/api/history?host=yd-mini&key=cpu.usage_pct&${suffix}`,
            headers: auth,
          })
        ).statusCode,
      ).toBe(400);
    const r = await app.inject({
      url: "/api/history?host=yd-mini&key=cpu.usage_pct&windowMs=60000",
      headers: auth,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json<{ points: unknown[] }>().points.length).toBeGreaterThan(0);
  });
});
describe("WebSocket handshake", () => {
  it("closes active websocket clients before shutting down the HTTP server", async () => {
    const { app } = setup();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw Error("address");
    const base = `127.0.0.1:${String(address.port)}`;
    const ws = new WebSocket(`ws://${base}/ws`, {
      headers: { cookie: await session(app), origin: `http://${base}` },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const closed = new Promise<void>((resolve) => {
      ws.once("close", () => {
        resolve();
      });
    });
    await app.close();
    await closed;
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  }, 2000);

  it("requires a session and same-origin handshake, then sends validated state", async () => {
    const { app } = setup();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw Error("address");
    const base = `127.0.0.1:${String(address.port)}`;
    const cookie = await session(app);
    const ws = new WebSocket(`ws://${base}/ws`, {
      headers: { cookie, origin: `http://${base}` },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("message", (data) => {
        expect(
          JSON.parse(
            Buffer.concat(
              Array.isArray(data) ? data : [Buffer.from(data as ArrayBuffer)],
            ).toString(),
          ) as unknown,
        ).toHaveProperty("hosts");
        resolve();
      });
      ws.once("error", reject);
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 9 * 3600_000);
    expect(
      await new Promise<number>((resolve) => {
        ws.once("close", resolve);
      }),
    ).toBe(1008);
    vi.useRealTimers();
    await expect(
      new Promise((resolve, reject) => {
        const bad = new WebSocket(`ws://${base}/ws?token=${TOKEN}`);
        bad.once("open", () => {
          bad.terminate();
          resolve(true);
        });
        bad.once("error", reject);
      }),
    ).rejects.toThrow("401");
  });
});
// The fixture directory is local, contains no user data and is unique to this test process.
process.once("exit", () => {
  rmSync(dir, { recursive: true, force: true });
});
