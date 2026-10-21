import { afterAll, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, type RequestOptions } from "node:https";
import { WebSocket } from "ws";
import { createApp } from "../src/app.ts";
import { config, TOKEN } from "./fixtures.ts";

const dir = mkdtempSync(join(tmpdir(), "archipel-tls-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
const certFile = join(dir, "cert.pem"),
  keyFile = join(dir, "key.pem"),
  opensslConfig = join(dir, "openssl.cnf");
writeFileSync(
  opensslConfig,
  `[req]
prompt = no
distinguished_name = subject
x509_extensions = server
[subject]
CN = localhost
[server]
subjectAltName = DNS:localhost,IP:127.0.0.1
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
`,
);
execFileSync(
  "/usr/bin/openssl",
  [
    "req",
    "-new",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-days",
    "1",
    "-config",
    opensslConfig,
    "-keyout",
    keyFile,
    "-out",
    certFile,
  ],
  { stdio: "ignore" },
);
writeFileSync(join(dir, "index.html"), "<h1>workbench</h1>");

function exchange(url: string, options: RequestOptions, body?: string) {
  return new Promise<{
    status: number | undefined;
    cookies: string[];
    body: string;
  }>((resolve, reject) => {
    const req = request(url, options, (response) => {
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("error", reject);
      response.on("end", () => {
        resolve({
          status: response.statusCode,
          cookies: response.headers["set-cookie"] ?? [],
          body,
        });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

it("serves verified HTTPS, Secure sessions and authenticated WSS", async () => {
  const { app } = createApp(
    { ...config, plugins: {}, tls: { certFile, keyFile } },
    { webDir: dir, startPolling: false },
  );
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw Error("address");
    const base = `https://127.0.0.1:${String(address.port)}`;
    const ca = readFileSync(certFile);
    await expect(exchange(`${base}/api/session`, {})).rejects.toThrow();
    await expect(
      exchange(`${base}/api/session`, { ca, servername: "wrong.test" }),
    ).rejects.toThrow(/not in the cert/);
    const login = await exchange(
      `${base}/api/session`,
      {
        ca,
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
      },
      JSON.stringify({ token: TOKEN }),
    );
    expect(login.status).toBe(200);
    expect(login.cookies[0]).toContain("; Secure");
    expect(login.cookies[0]).toContain("; HttpOnly");
    const cookie = login.cookies[0]?.split(";")[0] ?? "";
    expect(
      (
        await exchange(`${base}/api/state`, {
          ca,
          headers: { cookie },
        })
      ).status,
    ).toBe(200);
    const socket = new WebSocket(`${base.replace("https:", "wss:")}/ws`, {
      ca,
      headers: { cookie, origin: base },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("message", (data: Buffer) => {
          expect(JSON.parse(data.toString()) as unknown).toHaveProperty(
            "hosts",
          );
          resolve();
        });
        socket.once("error", reject);
      });
    } finally {
      socket.terminate();
    }
  } finally {
    await app.close();
  }
});

it("rejects unreadable TLS material before starting background workers", () => {
  expect(() =>
    createApp(
      { ...config, tls: { certFile, keyFile: join(dir, "missing.pem") } },
      { webDir: dir },
    ),
  ).toThrow(/ENOENT/);
});
