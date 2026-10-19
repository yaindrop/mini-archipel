import fastify from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, extname, sep } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import type { ConsoleConfig } from "./config.ts";
import {
  ArchipelMonitor,
  UpstreamError,
  curlTransport,
  type Transport,
} from "./archipel.ts";
import { Store } from "./store.ts";
import { archipelUpdate } from "./archipel-wire.ts";
import { METRIC_KEYS, stale } from "./domain.ts";
import { OkSchema } from "./contracts.ts";
import { PluginManager, type PluginDefinition } from "./plugins/runtime.ts";
import { DiskRulesUpdateSchema, DiskRulesViewSchema } from "./storage-rules.ts";
const COOKIE = "archipel-session";
function equal(a: string, b: string): boolean {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function signature(token: string, value: string): string {
  return createHmac("sha256", token).update(value).digest("base64url");
}
function authenticated(
  config: ConsoleConfig,
  headers: {
    authorization?: string | undefined;
    cookie?: string | undefined;
  },
): boolean {
  if (!config.uiToken) return true;
  if (
    headers.authorization &&
    equal(headers.authorization, `Bearer ${config.uiToken}`)
  )
    return true;
  const cookie = headers.cookie
    ?.split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (!cookie) return false;
  const [expires, sig] = cookie.split(".");
  return Boolean(
    expires &&
    sig &&
    Number(expires) > Date.now() &&
    equal(sig, signature(config.uiToken, expires)),
  );
}
export function createApp(
  config: ConsoleConfig,
  options: {
    webDir: string;
    transport?: Transport;
    startPolling?: boolean;
    plugins?: PluginDefinition[];
    persistConfig?: (config: ConsoleConfig) => void;
  },
) {
  const store = new Store(config.dbPath),
    monitor = new ArchipelMonitor(config, store, options.transport);
  const plugins = new PluginManager(
    config,
    {
      hosts: () => monitor.state().hosts,
      pollHost: (name) => monitor.pollHost(name),
      command: (name, path, body, method) =>
        monitor.command(name, path, body, method),
      transport: options.transport ?? curlTransport,
    },
    options.plugins ?? [],
    options.persistConfig,
  );
  const view = () => ({
    ...monitor.state(),
    plugins: plugins.views(),
  });
  const app = fastify({
    logger: false,
    bodyLimit: 16_384,
  });
  const sameOrigin = (headers: {
    origin?: string | undefined;
    host?: string | undefined;
  }) => {
    if (!headers.origin) return true;
    try {
      const origin = new URL(headers.origin);
      return (
        ["http:", "https:"].includes(origin.protocol) &&
        origin.host === headers.host
      );
    } catch {
      return false;
    }
  };
  app.addHook("onRequest", async (request, reply) => {
    reply
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "no-referrer")
      .header("x-frame-options", "DENY");
    reply.header(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    if (request.url.startsWith("/api/"))
      reply.header("cache-control", "no-store");
    if (request.method !== "GET" && !sameOrigin(request.headers))
      return reply.code(403).send({
        error: /*i18n*/ "不允许跨站操作",
      });
    if (
      request.url.split("?")[0] !== "/api/session" &&
      request.url.startsWith("/api/") &&
      !authenticated(config, request.headers)
    )
      return reply.code(401).send({
        error: /*i18n*/ "请先登录工作台",
      });
  });
  app.get("/api/session", (request) => ({
    authenticated: authenticated(config, request.headers),
    required: Boolean(config.uiToken),
  }));
  app.post("/api/session", async (request, reply) => {
    const input = z
      .object({
        token: z.string().max(1024),
      })
      .safeParse(request.body);
    if (
      !input.success ||
      (config.uiToken && !equal(input.data.token, config.uiToken))
    )
      return reply.code(401).send({
        error: /*i18n*/ "访问令牌不正确",
      });
    const expires = String(Date.now() + 8 * 3600_000);
    reply.header(
      "set-cookie",
      `${COOKIE}=${expires}.${signature(config.uiToken, expires)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${request.protocol === "https" ? "; Secure" : ""}`,
    );
    return {
      ok: true,
    };
  });
  app.delete("/api/session", async (_request, reply) => {
    reply.header(
      "set-cookie",
      `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
    );
    return {
      ok: true,
    };
  });
  app.get("/api/state", view);
  app.get("/api/config", () => ({
    version: "0.11.0",
    hosts: config.hosts.map(({ name, url }) => ({
      name,
      url,
    })),
    pollIntervalMs: 1000,
  }));
  app.get("/api/history", async (request, reply) => {
    const input = z
      .object({
        host: z.string(),
        key: z.enum(METRIC_KEYS),
        windowMs: z.coerce
          .number()
          .int()
          .min(60_000)
          .max(365 * 86400_000)
          .default(3600_000),
      })
      .safeParse(request.query);
    if (!input.success || !config.hosts.some((h) => h.name === input.data.host))
      return reply.code(400).send({
        error: /*i18n*/ "请选择有效的节点、指标与时间范围",
      });
    const { host, key, windowMs } = input.data,
      now = Date.now();
    return {
      host,
      key,
      points: await store.queryRange(host, key, now - windowMs, now),
    };
  });
  app.put<{
    Params: {
      id: string;
    };
  }>("/api/plugins/:id", async (request, reply) => {
    const input = z
      .strictObject({
        enabled: z.boolean(),
      })
      .safeParse(request.body);
    if (!input.success)
      return reply.code(400).send({
        error: /*i18n*/ "缺少有效的插件开关",
      });
    await plugins.setEnabled(request.params.id, input.data.enabled);
    return {
      ok: true,
    };
  });
  app.put<{
    Params: {
      host: string;
      id: string;
    };
  }>("/api/hosts/:host/plugins/:id", async (request, reply) => {
    const input = z
      .strictObject({
        enabled: z.boolean(),
      })
      .safeParse(request.body);
    if (!input.success)
      return reply.code(400).send({
        error: /*i18n*/ "缺少有效的插件开关",
      });
    OkSchema.parse(
      await plugins.setAgentEnabled(
        request.params.host,
        request.params.id,
        input.data.enabled,
      ),
    );
    return {
      ok: true,
    };
  });
  app.post<{
    Params: {
      id: string;
      action: string;
    };
  }>("/api/plugins/:id/actions/:action", async (request) =>
    plugins.action(request.params.id, request.params.action, request.body),
  );
  app.get<{ Params: { host: string } }>(
    "/api/hosts/:host/disk-rules",
    async (request, reply) => {
      if (!monitor.state().hosts.some((h) => h.name === request.params.host))
        return reply.code(404).send({ error: /*i18n*/ "节点不存在" });
      return DiskRulesViewSchema.parse(
        await monitor.command(request.params.host, "disk-rules"),
      );
    },
  );
  app.put<{ Params: { host: string } }>(
    "/api/hosts/:host/disk-rules",
    { bodyLimit: 600_000 },
    async (request, reply) => {
      const input = DiskRulesUpdateSchema.safeParse(request.body);
      if (!input.success)
        return reply
          .code(400)
          .send({ error: /*i18n*/ "目录规则无效，请检查路径、深度和分类" });
      const host = monitor
        .state()
        .hosts.find((h) => h.name === request.params.host);
      if (!host) return reply.code(404).send({ error: /*i18n*/ "节点不存在" });
      if (stale(host, Date.now()))
        return reply
          .code(409)
          .send({ error: /*i18n*/ "节点离线，无法保存目录规则" });
      try {
        return DiskRulesViewSchema.parse(
          await monitor.command(host.name, "disk-rules", input.data, "PUT"),
        );
      } catch (error) {
        if (error instanceof UpstreamError && error.status === 409)
          return reply
            .code(409)
            .send({ error: /*i18n*/ "目录规则已变更，请重新载入后再保存" });
        if (error instanceof UpstreamError && error.status === 400)
          return reply
            .code(400)
            .send({ error: /*i18n*/ "目录规则无效，请检查路径是否重复" });
        throw error;
      }
    },
  );
  app.post("/api/disk/rescan", async (request, reply) => {
    const input = z
      .object({
        host: z.string(),
        path: z.string().min(1).max(4096).optional(),
      })
      .safeParse(request.body);
    if (!input.success)
      return reply.code(400).send({ error: /*i18n*/ "缺少有效的节点或目录" });
    const host = monitor.state().hosts.find((h) => h.name === input.data.host);
    if (!host)
      return reply.code(404).send({
        error: /*i18n*/ "节点不存在",
      });
    if (stale(host, Date.now()))
      return reply.code(409).send({
        error: /*i18n*/ "节点离线，扫描未执行",
      });
    OkSchema.parse(
      await monitor.command(
        host.name,
        "rescan-disk",
        input.data.path ? { path: input.data.path } : {},
      ),
    );
    await monitor.pollHost(host.name);
    return {
      ok: true,
    };
  });
  app.post("/api/disk/cancel", async (request, reply) => {
    const input = z
      .object({ host: z.string(), id: z.number().int().positive() })
      .safeParse(request.body);
    if (!input.success)
      return reply
        .code(400)
        .send({ error: /*i18n*/ "缺少有效的节点或扫描任务" });
    const host = monitor.state().hosts.find((h) => h.name === input.data.host);
    if (!host) return reply.code(404).send({ error: /*i18n*/ "节点不存在" });
    if (stale(host, Date.now()))
      return reply.code(409).send({ error: /*i18n*/ "节点离线，无法取消扫描" });
    OkSchema.parse(
      await monitor.command(host.name, "cancel-disk-scan", {
        id: input.data.id,
      }),
    );
    await monitor.pollHost(host.name);
    return { ok: true };
  });
  app.setErrorHandler((error, _request, reply) => {
    const status =
      error instanceof UpstreamError
        ? error.status
        : error instanceof Error &&
            "statusCode" in error &&
            typeof error.statusCode === "number" &&
            error.statusCode >= 400 &&
            error.statusCode < 500
          ? error.statusCode
          : 500;
    void reply.code(status).send({
      error:
        error instanceof UpstreamError
          ? error.message
          : /*i18n*/ "服务暂时无法完成请求",
    });
  });
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".map": "application/json",
  };
  app.setNotFoundHandler((request, reply) => {
    if (
      request.url.startsWith("/api/") ||
      (request.method !== "GET" && request.method !== "HEAD")
    )
      return reply.code(404).send({
        error: /*i18n*/ "接口不存在",
      });
    const pathname = decodeURIComponent(request.url.split("?")[0] ?? "/"),
      webDir = resolve(options.webDir),
      target = resolve(webDir, `.${pathname}`);
    if (target !== webDir && !target.startsWith(webDir + sep))
      return reply.code(403).send({
        error: /*i18n*/ "路径无效",
      });
    const file =
      pathname.startsWith("/nodes/") || !extname(pathname)
        ? resolve(webDir, "index.html")
        : target;
    try {
      const body = readFileSync(file);
      reply.header(
        "content-type",
        types[extname(file)] ?? "application/octet-stream",
      );
      reply.header(
        "cache-control",
        pathname.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      );
      return reply.send(body);
    } catch {
      return reply.code(404).send({
        error: /*i18n*/ "页面资源不存在",
      });
    }
  });
  const wss = new WebSocketServer({
    noServer: true,
  });
  app.server.on("upgrade", (request, socket, head) => {
    if (
      request.url !== "/ws" ||
      !sameOrigin(request.headers) ||
      !authenticated(config, request.headers)
    ) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });
  const sessions = new WeakMap<
    WebSocket,
    {
      authorization?: string | undefined;
      cookie?: string | undefined;
    }
  >();
  wss.on("connection", (socket, request) => {
    sessions.set(socket, request.headers);
    const versions = new Map<string, string>();
    directoryVersions.set(socket, versions);
    socket.send(JSON.stringify(archipelUpdate(view(), versions)));
    socket.on("error", () => {
      socket.close();
    });
  });
  const directoryVersions = new WeakMap<WebSocket, Map<string, string>>();
  const broadcast = setInterval(() => {
    if (!wss.clients.size) return;
    const state = view();
    for (const socket of wss.clients) {
      if (!authenticated(config, sessions.get(socket) ?? {})) {
        socket.close(1008, "Session expired");
        continue;
      }
      if (
        socket.readyState === WebSocket.OPEN &&
        socket.bufferedAmount < 1_000_000
      )
        socket.send(
          JSON.stringify(
            archipelUpdate(
              state,
              directoryVersions.get(socket) ?? new Map<string, string>(),
            ),
          ),
        );
    }
  }, 1000);
  if (options.startPolling !== false) {
    monitor.start();
    plugins.start();
  }
  app.addHook("preClose", (done) => {
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    done();
  });
  app.addHook("onClose", async () => {
    clearInterval(broadcast);
    plugins.stop();
    await monitor.stop();
    await store.close();
  });
  return {
    app,
    monitor,
    store,
    plugins,
  };
}
