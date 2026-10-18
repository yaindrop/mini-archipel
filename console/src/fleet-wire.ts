import { FleetUpdateSchema, type Fleet, type Snapshot } from "./contracts.ts";

/** Only immutable directory results can be omitted; task progress always travels. */
export function fleetUpdate(fleet: Fleet, versions: Map<string, string>) {
  return {
    ...fleet,
    hosts: fleet.hosts.map((host) => {
      const snapshot = host.snapshot,
        revision = snapshot?.disk_revision;
      if (!snapshot || !revision) return host;
      const known = versions.get(host.name);
      versions.set(host.name, revision);
      if (known !== revision) return host;
      const update = { ...snapshot, disk_scans: undefined };
      return { ...host, snapshot: update };
    }),
  };
}
export function restoreSnapshot(
  update: ReturnType<
    typeof import("./contracts.ts").SnapshotUpdateSchema.parse
  >,
  previous: Snapshot | null | undefined,
): Snapshot {
  if (update.disk_scans) return { ...update, disk_scans: update.disk_scans };
  if (
    !previous ||
    !update.disk_revision ||
    update.disk_revision !== previous.disk_revision
  )
    throw new Error("directory revision is missing");
  return { ...update, disk_scans: previous.disk_scans };
}
export function restoreFleet(
  value: unknown,
  previous: Fleet | undefined,
): Fleet {
  const update = FleetUpdateSchema.parse(value);
  return {
    ...update,
    hosts: update.hosts.map((host) => ({
      ...host,
      snapshot: host.snapshot
        ? restoreSnapshot(
            host.snapshot,
            previous?.hosts.find((item) => item.name === host.name)?.snapshot,
          )
        : null,
    })),
  };
}
