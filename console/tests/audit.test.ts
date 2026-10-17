import { expect, it } from "vitest";
import { auditFailures } from "../scripts/audit.ts";
const advisory = { url: "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm" };
const leaf = {
  severity: "high",
  nodes: ["node_modules/braces"],
  via: [advisory],
};
const tool = {
  severity: "high",
  nodes: ["node_modules/tool"],
  via: ["braces"],
};
const lock = {
  packages: {
    "node_modules/braces": { dev: true },
    "node_modules/tool": { dev: true },
  },
};
it("allows only complete development-only chains to the exact waived advisory", () => {
  expect(
    auditFailures({ vulnerabilities: { braces: leaf, tool } }, lock),
  ).toEqual([]);
  expect(
    auditFailures(
      { vulnerabilities: { braces: leaf, tool } },
      {
        packages: { ...lock.packages, "node_modules/braces": {} },
      },
    ),
  ).toEqual(["braces", "tool"]);
});
it("rejects new advisories, missing references, empty evidence and cycles", () => {
  for (const entry of [
    { ...leaf, via: [{ url: "https://example.com/new-advisory" }] },
    { ...leaf, via: ["missing"] },
    { ...leaf, via: [] },
    { ...leaf, nodes: [] },
    { ...leaf, nodes: ["node_modules/missing"] },
    { ...leaf, via: ["braces"] },
  ]) {
    expect(auditFailures({ vulnerabilities: { braces: entry } }, lock)).toEqual(
      ["braces"],
    );
  }
  expect(() => auditFailures({ error: "offline" }, lock)).toThrow();
});
