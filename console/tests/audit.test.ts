import { expect, it } from "vitest";
import { auditFailures } from "../scripts/audit.ts";
const waived = {
  severity: "high",
  module_name: "braces",
  github_advisory_id: "GHSA-vfj7-8cjw-p6xm",
  findings: [
    { paths: [".>eslint-plugin-lingui>micromatch>braces"], dev: true },
  ],
};
it("waives the build-tool advisory only while every finding is dev-only", () => {
  expect(auditFailures({ advisories: { "1240992": waived } })).toEqual([]);
  expect(
    auditFailures({
      advisories: {
        "1240992": {
          ...waived,
          findings: [
            { paths: [".>app>braces"], dev: false },
            { paths: [".>eslint-plugin-lingui>braces"], dev: true },
          ],
        },
      },
    }),
  ).toEqual(["braces"]);
});
it("fails the same advisory when its identity is missing", () => {
  const unidentified = {
    severity: "high",
    module_name: "braces",
    findings: [{ paths: ["."], dev: true }],
  };
  expect(auditFailures({ advisories: { "1": unidentified } })).toEqual([
    "braces",
  ]);
});
it("reports every other high or critical advisory", () => {
  expect(
    auditFailures({
      advisories: {
        "1": waived,
        "2": {
          severity: "critical",
          module_name: "left-pad",
          github_advisory_id: "GHSA-1111-1111-1111",
          findings: [{ paths: ["."], dev: true }],
        },
      },
    }),
  ).toEqual(["left-pad"]);
});
it("ignores severities below high", () => {
  expect(
    auditFailures({
      advisories: {
        "1": { ...waived, severity: "moderate", github_advisory_id: "GHSA-2" },
      },
    }),
  ).toEqual([]);
});
it("rejects malformed reports and advisories without evidence", () => {
  expect(() => auditFailures({ error: "offline" })).toThrow();
  expect(() =>
    auditFailures({ advisories: { "1": { ...waived, findings: [] } } }),
  ).toThrow();
});
