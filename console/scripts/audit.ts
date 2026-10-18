import { spawnSync } from "node:child_process";
import { z } from "zod";
// No patch exists for this build-tool advisory. Only repository-owned glob patterns
// reach braces; browser inputs never reach the extractor or linter. See ENGINEERING.md.
const buildOnlyAdvisory = "GHSA-vfj7-8cjw-p6xm";
const finding = z.object({
  paths: z.array(z.string()).min(1),
  dev: z.boolean(),
});
const advisory = z.object({
  severity: z.string(),
  module_name: z.string(),
  github_advisory_id: z.string().optional(),
  findings: z.array(finding).min(1),
});
const report = z.object({
  advisories: z.record(z.string(), advisory),
});
export function auditFailures(rawReport: unknown): string[] {
  const audit = report.parse(rawReport);
  return Object.entries(audit.advisories)
    .filter(([, item]) => ["high", "critical"].includes(item.severity))
    .filter(
      ([, item]) =>
        !(
          item.github_advisory_id === buildOnlyAdvisory &&
          item.findings.every((entry) => entry.dev)
        ),
    )
    .map(([, item]) => item.module_name);
}
if (import.meta.main) {
  const result = spawnSync("pnpm", ["audit", "--json"], {
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1)
    throw new Error("Dependency audit could not complete");
  const audit = report.parse(JSON.parse(result.stdout) as unknown);
  const failures = auditFailures(audit);
  if (failures.length)
    throw new Error(`Dependency audit failed: ${failures.join(", ")}`);
  console.log(
    Object.values(audit.advisories).some((item) =>
      ["high", "critical"].includes(item.severity),
    )
      ? "Full dependency tree: only unpatched build-only GHSA-vfj7-8cjw-p6xm is waived."
      : "Dependency audit: no high/critical vulnerabilities.",
  );
}
