import { describe, it, expect } from "vitest";
import {
  fleetUpdate,
  restoreFleet,
  restoreSnapshot,
} from "../src/fleet-wire.ts";
import { makeHost, makeSnapshot } from "./fixtures.ts";
import type { Fleet } from "../src/contracts.ts";
describe("directory revision protocol", () => {
  it("sends a full baseline, omits unchanged trees and restores them by reference", () => {
    const host = makeHost();
    const snapshot = makeSnapshot();
    host.snapshot = snapshot;
    snapshot.disk_revision = "boot:1";
    const fleet: Fleet = { ts: Date.now(), hosts: [host], plugins: {} };
    const versions = new Map<string, string>();
    const initial = restoreFleet(
      JSON.parse(JSON.stringify(fleetUpdate(fleet, versions))) as unknown,
      undefined,
    );
    const wire = JSON.parse(
      JSON.stringify(fleetUpdate(fleet, versions)),
    ) as unknown;
    const current = restoreFleet(wire, initial);
    expect(current.hosts[0]?.snapshot?.disk_scans).toBe(
      initial.hosts[0]?.snapshot?.disk_scans,
    );
    expect(JSON.stringify(wire).length).toBeLessThan(
      JSON.stringify(fleet).length,
    );
    snapshot.disk_revision = "boot:2";
    snapshot.disk_scans = [];
    expect(
      restoreFleet(fleetUpdate(fleet, versions), current).hosts[0]?.snapshot
        ?.disk_scans,
    ).toEqual([]);
  });
  it("requires a full tree after a lost baseline or agent restart", () => {
    const full = makeSnapshot();
    full.disk_revision = "boot:1";
    const update = { ...full, disk_scans: undefined };
    expect(() => restoreSnapshot(update, null)).toThrow("revision");
    expect(() =>
      restoreSnapshot({ ...update, disk_revision: "next-boot:1" }, full),
    ).toThrow("revision");
    expect(restoreSnapshot(full, null).disk_scans).toEqual(full.disk_scans);
  });
});
