import { describe, expect, it } from "vitest";
import { decide } from "@/engine/decide";
import { syntheticExport, SYNTHETIC_EXPORTED_AT } from "@/engine/data/synthetic";
import { DEFAULT_TENANTS } from "@/engine/tenants";
import type { ProposalView } from "@/server/service";
import { buildBoard, isRoutine, judgmentReason, laneOf, splitSlice, spotCheck } from "@/components/board";

const { carts, accounts } = syntheticExport();
const run = decide({ carts, fanAccounts: accounts, contactHistory: [], tenants: DEFAULT_TENANTS, asOf: SYNTHETIC_EXPORTED_AT });
const views: ProposalView[] = run.decisions
  .filter((d) => d.outcome === "propose")
  .map((d, i) => ({
    id: i + 1, runId: 1, decisionKey: d.key, tenantId: d.tenantId, fanId: d.fanId, matchId: d.matchId, cartIds: d.cartIds,
    outcome: d.outcome, reasonCodes: d.reasonCodes, reason: d.reason, proposal: d.proposal!, copy: null, copySource: null,
    copyFallbackReason: null, copyNotes: [], modelName: null, status: "pending_review", statusDetail: null, consent: null, rawCarts: [], audit: [],
  }));
const now = SYNTHETIC_EXPORTED_AT;
const total = (b: ReturnType<typeof buildBoard>) => Object.values(b.cells).reduce((s, c) => s + c.items.length, 0);

describe("review board", () => {
  it("offer columns: one row per match, most urgent first, every offer in exactly one cell", () => {
    const b = buildBoard(views, "offer", now);
    expect(b.rows.length).toBe(3);
    expect(total(b)).toBe(views.length);
    const earliest = b.rows.map((r) => Object.values(b.cells).filter((c) => c.rowKey === r.key).map((c) => c.earliestDeadline).sort()[0]);
    expect([...earliest].sort()).toEqual(earliest);
  });

  it("deadline columns: rows are offer types, columns are lanes, nothing lost", () => {
    const b = buildBoard(views, "deadline", now);
    expect(b.cols.map((c) => c.key)).toEqual(["today", "tomorrow", "week", "later"]);
    expect(total(b)).toBe(views.length);
  });

  it("lanes follow the send-by time on the app clock", () => {
    const p = views[0];
    const at = (hoursBefore: number) => new Date(Date.parse(p.proposal!.expiresAt) - hoursBefore * 3_600_000).toISOString();
    expect(laneOf(p, at(5))).toBe("today");
    expect(laneOf(p, at(30))).toBe("tomorrow");
    expect(laneOf(p, at(100))).toBe("week");
    expect(laneOf(p, at(500))).toBe("later");
  });

  it("only plain reminders to directly identified fans are routine", () => {
    const reminder = views.find((p) => p.proposal!.offer.type === "reminder" && !p.reasonCodes.includes("GUEST_MATCHED_BY_EMAIL"))!;
    expect(isRoutine(reminder)).toBe(true);
    expect(isRoutine({ ...reminder, status: "blocked" })).toBe(false);
    expect(isRoutine({ ...reminder, reasonCodes: [...reminder.reasonCodes, "GUEST_MATCHED_BY_EMAIL"] })).toBe(false);
    expect(isRoutine({ ...reminder, proposal: { ...reminder.proposal!, offer: { type: "promo_code", percentOff: 10, singleUse: true } } })).toBe(false);
    const perk = views.find((p) => p.proposal!.offer.type === "perk")!;
    expect(isRoutine(perk)).toBe(false);
  });

  it("splitting a slice loses nothing and puts failed, then blocked, first", () => {
    const sample = [...views.slice(0, 20)];
    sample[5] = { ...sample[5], status: "blocked" };
    sample[9] = { ...sample[9], status: "failed" };
    const { routine, judgment } = splitSlice(sample);
    expect(routine.length + judgment.length).toBe(sample.length);
    expect(judgment[0].status).toBe("failed");
    expect(judgment[1].status).toBe("blocked");
  });

  it("spot-check is a repeatable subset of the batch", () => {
    const { routine } = splitSlice(views);
    const a = spotCheck(routine);
    expect(a.length).toBe(5);
    expect(spotCheck(routine)).toEqual(a);
    for (const p of a) expect(routine).toContain(p);
    expect(spotCheck(routine.slice(0, 2)).length).toBe(2);
  });

  it("every needs-judgment item says why, and routine items say nothing", () => {
    for (const p of views) expect(judgmentReason(p) === "").toBe(isRoutine(p));
    const guest = views.find((p) => p.reasonCodes.includes("GUEST_MATCHED_BY_EMAIL") && p.proposal!.offer.type === "reminder");
    if (guest) expect(judgmentReason(guest)).toMatch(/guest/i);
  });
});
