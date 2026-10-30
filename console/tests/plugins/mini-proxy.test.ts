import { describe, expect, it } from "vitest";
import { ActionReplySchema } from "../../src/plugins/mini-proxy/contracts.ts";
import { checkNodes, nodeDelay } from "../../src/plugins/mini-proxy/domain.ts";

describe("mini-proxy delay", () => {
  it("shows the measured delay for a passed node and -1 for a failed check", () => {
    expect(nodeDelay(undefined)).toBeNull();
    expect(nodeDelay({ ok: true, check_ms: 179 })).toBe(179);
    expect(
      nodeDelay({
        ok: true,
        check_ms: 2404,
        detail: "latency_ms 144\nakile-de: delay ok",
      }),
    ).toBe(144);
    expect(nodeDelay({ ok: false, check_ms: 2165 })).toBe(-1);
  });

  it("counts failed checks and keeps going after a request error", async () => {
    const seen: string[] = [];
    const failed = await checkNodes(
      ["akile-sg", "akile-de", "akko-lon"],
      (node) => {
        seen.push(node);
        if (node === "akko-lon") return Promise.reject(new Error("offline"));
        return Promise.resolve({ ok: node !== "akile-de" });
      },
    );
    expect(seen).toEqual(["akile-sg", "akile-de", "akko-lon"]);
    expect(failed).toBe(2);
  });

  it("accepts a completed check that did not pass", () => {
    expect(
      ActionReplySchema.parse({
        ok: false,
        output: "akile-de did not pass the GitHub network check",
        check_ms: 2165,
        error: "mini-proxy-select exited with 1",
      }),
    ).toEqual({ ok: false });
  });
});
