import { describe, it, expect } from "vitest";
import {
  DiskRulesUpdateSchema,
  directoryRuleRows,
  ruleKey,
  type DiskRulesView,
} from "../src/storage-rules.ts";
const view: DiskRulesView = {
  revision: "v1",
  home: "/Users/test",
  roots: ["/", "/Users/test"],
  config: { use_defaults: true, rules: [] },
  defaults: [{ path: "~/Library", depth: 1, class: "library" }],
  plugins: [{ plugin: "runners", path: "/Users/test/runners" }],
};
describe("directory rule layers", () => {
  it("keeps plugin sources and independently inherits overridden fields", () => {
    const config = {
      use_defaults: true,
      rules: [
        { path: "/Users/test/Library/", depth: 3 },
        { path: "~/runners", class: "toolchain" as const },
        { path: "~/custom", depth: 2, class: "user" as const },
      ],
    };
    const rows = directoryRuleRows(view, config);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.origin === "default")).toMatchObject({
      path: "~/Library",
      depth: 3,
      class: "library",
      override: config.rules[0],
    });
    expect(rows.find((r) => r.origin === "plugin")).toMatchObject({
      path: "~/runners",
      depth: 1,
      class: "toolchain",
      plugins: ["runners"],
    });
    expect(rows.find((r) => r.origin === "custom")?.base).toBeNull();
    expect(
      directoryRuleRows(view, { use_defaults: false, rules: [] }),
    ).toHaveLength(1);
    expect(ruleKey("~/Library//./Caches/", view.home)).toBe(
      "/Users/test/Library/Caches",
    );
  });
  it("rejects traversal, relative paths, unsupported fields and invalid depth/class", () => {
    for (const rule of [
      { path: "../etc" },
      { path: "~/../etc" },
      { path: "/tmp\n/x" },
      { path: "/tmp", depth: 5 },
      { path: "/tmp", class: "cache" },
      { path: "/tmp", executable: "anything" },
    ])
      expect(
        DiskRulesUpdateSchema.safeParse({
          revision: "v1",
          config: { use_defaults: true, rules: [rule] },
        }).success,
      ).toBe(false);
  });
});
