import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { z } from "zod";
// No patch exists for this build-tool advisory. Only repository-owned glob patterns
// reach braces; browser inputs never reach the extractor or linter. See ENGINEERING.md.
const buildOnlyAdvisory = "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm";
const vulnerability = z.object({
  severity: z.string(),
  nodes: z.array(z.string()),
  via: z.array(z.union([z.string(), z.object({ url: z.string() })])),
});
const report = z.object({
  vulnerabilities: z.record(z.string(), vulnerability),
});
const lockSchema = z.object({
  packages: z.record(z.string(), z.object({ dev: z.boolean().optional() })),
});
export function auditFailures(rawReport: unknown, rawLock: unknown): string[] {
  const audit = report.parse(rawReport);
  const lock = lockSchema.parse(rawLock);
  const waived = (name: string, ancestors = new Set<string>()): boolean => {
    const item = audit.vulnerabilities[name];
    if (!item || ancestors.has(name)) return false;
    const seen = new Set(ancestors).add(name);
    return (
      item.nodes.length > 0 &&
      item.nodes.every((path) => lock.packages[path]?.dev === true) &&
      item.via.length > 0 &&
      item.via.every((entry) =>
        typeof entry === "string"
          ? waived(entry, seen)
          : entry.url === buildOnlyAdvisory,
      )
    );
  };
  return Object.entries(audit.vulnerabilities)
    .filter(
      ([name, item]) =>
        ["high", "critical"].includes(item.severity) && !waived(name),
    )
    .map(([name]) => name);
}
if (import.meta.main) {
  const result = spawnSync("npm", ["audit", "--json"], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1)
    throw new Error("Dependency audit could not complete");
  const audit = report.parse(JSON.parse(result.stdout) as unknown);
  const failures = auditFailures(
    audit,
    JSON.parse(readFileSync("package-lock.json", "utf8")) as unknown,
  );
  if (failures.length)
    throw new Error(`Dependency audit failed: ${failures.join(", ")}`);
  console.log(
    Object.values(audit.vulnerabilities).some((item) =>
      ["high", "critical"].includes(item.severity),
    )
      ? "Production dependencies: 0 high/critical vulnerabilities. Only unpatched build-only GHSA-vfj7-8cjw-p6xm is waived."
      : "Dependency audit: no high/critical vulnerabilities.",
  );
}
