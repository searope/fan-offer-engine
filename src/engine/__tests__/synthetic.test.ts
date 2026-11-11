import { describe, expect, it } from "vitest";
import { checkExport } from "@/engine/contract";
import { decide } from "@/engine/decide";
import { syntheticExport, SYNTHETIC_EXPORTED_AT } from "@/engine/data/synthetic";
import { DEFAULT_TENANTS } from "@/engine/tenants";

const { carts, accounts } = syntheticExport();

describe("synthetic export (queue-at-scale demo data)", () => {
  it("is deterministic", () => expect(syntheticExport()).toEqual(syntheticExport()));

  it("is big enough to need grouping: 100+ carts over 3 matches", () => {
    expect(carts.length).toBeGreaterThan(100);
    expect(new Set(carts.map((c) => c.match)).size).toBe(3);
  });

  it("passes the export checks, so a run isn't paused", () => {
    const fanRecords = accounts.map((a) => {
      const rows = carts.filter((c) => c.fanId === a.fanId);
      return { fanId: a.fanId, email: rows.every((c) => c.emailOptIn === "Yes"), push: rows.every((c) => c.pushOptIn === "Yes") };
    });
    expect(checkExport({ carts, exportedAt: SYNTHETIC_EXPORTED_AT, asOf: SYNTHETIC_EXPORTED_AT, previous: null, fanRecords }).problems).toEqual([]);
  });

  it("produces every outcome, including merged and guest-linked decisions", () => {
    const run = decide({ carts, fanAccounts: accounts, contactHistory: [], tenants: DEFAULT_TENANTS, asOf: SYNTHETIC_EXPORTED_AT });
    const outcomes = new Set(run.decisions.map((d) => d.outcome));
    expect([...outcomes].sort()).toEqual(["holdout", "propose", "suppress"]);
    expect(run.decisions.filter((d) => d.outcome === "propose").length).toBeGreaterThan(50);
    expect(run.decisions.some((d) => d.reasonCodes.includes("MERGED_DUPLICATE_CARTS"))).toBe(true);
    expect(run.decisions.some((d) => d.reasonCodes.includes("GUEST_MATCHED_BY_EMAIL"))).toBe(true);
  });
});
