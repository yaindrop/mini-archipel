import {
  ArchipelUpdateSchema,
  type Archipel,
  type Snapshot,
} from "./contracts.ts";

/** Only immutable directory results can be omitted; task progress always travels. */
export function archipelUpdate(
  archipel: Archipel,
  versions: Map<string, string>,
) {
  return {
    ...archipel,
    hosts: archipel.hosts.map((host) => {
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
export function restoreArchipel(
  value: unknown,
  previous: Archipel | undefined,
): Archipel {
  const update = ArchipelUpdateSchema.parse(value);
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
