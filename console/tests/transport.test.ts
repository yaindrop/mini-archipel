import { createServer } from "node:http";
import { once } from "node:events";
import { describe, it, expect } from "vitest";
import { curlTransport } from "../src/archipel.ts";
describe("macOS curl transport", () => {
  it("sends credentials through config stdin, preserves JSON and rejects HTTP failures", async () => {
    let auth = "",
      body = "";
    const server = createServer((req, res) => {
      auth = req.headers.authorization ?? "";
      req.on("data", (data: Buffer) => {
        body += data.toString();
      });
      req.on("end", () => {
        res.statusCode = req.url === "/busy" ? 409 : 200;
        res.end(
          req.url === "/invalid" ? "not-json" : JSON.stringify({ ok: true }),
        );
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw Error("address");
    const url = `http://127.0.0.1:${String(address.port)}`;
    try {
      const payload = { text: 'quoted " value\n next line' };
      expect(await curlTransport(url, "test-token", payload)).toEqual({
        ok: true,
      });
      expect(auth).toBe("Bearer test-token");
      expect(JSON.parse(body) as unknown).toEqual(payload);
      await expect(curlTransport(url + "/busy", "test-token")).rejects.toThrow(
        "HTTP 409",
      );
      await expect(
        curlTransport(url + "/invalid", "test-token"),
      ).rejects.toThrow("无效数据");
    } finally {
      server.close();
      await once(server, "close");
    }
    await expect(curlTransport(url, "test-token")).rejects.toThrow("无法连接");
  });
});
