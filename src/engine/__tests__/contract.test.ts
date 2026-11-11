/**
 * The load-bearing assumption: the ticketing export's sell-through and consent can be trusted.
 * checkExport() is where that assumption is tested on every run. A failing export pauses the run
 * before decide() sees it (SPEC §0).
 */
import { describe, expect, it } from "vitest";
import { checkExport, type ExportSnapshot } from "@/engine/contract";
import { SAMPLE_AS_OF, SAMPLE_CARTS, type RawCartRow } from "@/engine/data/sample-carts";

const HOUR = 3_600_000;
const at = (hours: number) => new Date(Date.parse(SAMPLE_AS_OF) + hours * HOUR).toISOString();
// Fan records that agree with the export (how the demo seeds them).
const agreeing = [...new Set(SAMPLE_CARTS.filter((c) => /^F-\d+$/.test(c.fanId)).map((c) => c.fanId))].map((fanId) => {
  const rows = SAMPLE_CARTS.filter((c) => c.fanId === fanId);
  return { fanId, email: rows.every((r) => r.emailOptIn === "Yes"), push: rows.every((r) => r.pushOptIn === "Yes") };
});
const check = (over: Partial<Parameters<typeof checkExport>[0]> = {}) =>
  checkExport({ carts: SAMPLE_CARTS, exportedAt: SAMPLE_AS_OF, asOf: SAMPLE_AS_OF, previous: null, fanRecords: agreeing, ...over });
const codes = (r: ReturnType<typeof checkExport>) => r.problems.map((p) => p.code);

describe("checkExport", () => {
  it("the sample export passes", () => {
    const r = check();
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.snapshot.rowCount).toBe(8);
  });

  it("an export older than 6 hours is stale", () => {
    expect(codes(check({ asOf: at(5) }))).not.toContain("STALE_EXPORT");
    expect(codes(check({ asOf: at(96) }))).toContain("STALE_EXPORT");
  });

  it("an export stamped in the future is rejected", () => expect(codes(check({ asOf: at(-1) }))).toContain("STALE_EXPORT"));

  it("one match+section reported with two different sell-through values is inconsistent", () => {
    const carts = SAMPLE_CARTS.map((c) => (c.cartId === "C-1006" ? { ...c, sectionSoldPct: "70%" } : c));
    expect(codes(check({ carts }))).toContain("SELL_THROUGH_INCONSISTENT");
  });

  it("sell-through falling more than 10 points since the last accepted export is implausible", () => {
    const base = check().snapshot;
    const key = Object.keys(base.sellThrough).find((k) => k.endsWith("|Lower Bowl"))!;
    const prev = (pct: number): ExportSnapshot => ({ ...base, sellThrough: { ...base.sellThrough, [key]: pct } });
    expect(codes(check({ previous: prev(95) }))).not.toContain("SELL_THROUGH_DROP"); // 95 -> 88: refunds happen
    expect(codes(check({ previous: prev(99) }))).toContain("SELL_THROUGH_DROP"); // 99 -> 88: something's wrong
  });

  it("a big swing in the opted-in share is flagged once there are enough rows to tell", () => {
    const many = (optIn: string): RawCartRow[] =>
      Array.from({ length: 30 }, (_, i) => ({ ...SAMPLE_CARTS[1], cartId: `X-${i}`, fanId: `F-${900 + i}`, emailOptIn: optIn }));
    const prev = check({ carts: many("Yes"), fanRecords: [] }).snapshot;
    expect(codes(check({ carts: many("No"), fanRecords: [], previous: prev }))).toContain("CONSENT_SHARE_SHIFT");
    // 8 sample rows: too few to judge a share, so no flag either way
    expect(codes(check({ previous: { ...check().snapshot, emailOptInShare: 0 } }))).not.toContain("CONSENT_SHARE_SHIFT");
  });

  it("an export that says opted-in where the fan record says opted-out, for many fans, is stale consent", () => {
    const flipped = agreeing.map((f, i) => (i < 3 ? { ...f, email: false, push: false } : f));
    expect(codes(check({ fanRecords: flipped }))).toContain("CONSENT_DISAGREES_WITH_FAN_RECORD");
    const oneFlip = agreeing.map((f, i) => (i === 0 ? { ...f, push: false } : f));
    expect(codes(check({ fanRecords: oneFlip }))).not.toContain("CONSENT_DISAGREES_WITH_FAN_RECORD"); // normal churn
  });

  it("too many rows with unreadable decision fields fails", () => {
    const carts = SAMPLE_CARTS.map((c, i) => (i < 3 ? { ...c, cartValue: "??" } : c));
    expect(codes(check({ carts }))).toContain("FIELD_UNREADABLE");
  });

  it("every problem has a message a marketer can read", () => {
    for (const p of check({ asOf: at(96) }).problems) expect(p.message.length).toBeGreaterThan(20);
  });
});
