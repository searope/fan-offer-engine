import { describe, expect, it } from "vitest";
import { decide } from "@/engine/decide";
import { syntheticExport, SYNTHETIC_EXPORTED_AT } from "@/engine/data/synthetic";
import { DEFAULT_TENANTS } from "@/engine/tenants";
import type { ProposalView } from "@/server/service";
import { applyFilters, DEFAULT_FILTERS, groupProposals } from "@/components/queueView";

// Turn engine decisions into the view shape the UI works with.
const { carts, accounts } = syntheticExport();
const run = decide({ carts, fanAccounts: accounts, contactHistory: [], tenants: DEFAULT_TENANTS, asOf: SYNTHETIC_EXPORTED_AT });
const views: ProposalView[] = run.decisions
  .filter((d) => d.outcome === "propose")
  .sort((a, b) => a.proposal!.expiresAt.localeCompare(b.proposal!.expiresAt))
  .map((d, i) => ({
    id: i + 1, runId: 1, decisionKey: d.key, tenantId: d.tenantId, fanId: d.fanId, matchId: d.matchId, cartIds: d.cartIds,
    outcome: d.outcome, reasonCodes: d.reasonCodes, reason: d.reason, proposal: d.proposal!, copy: null, copySource: null,
    copyFallbackReason: null, copyNotes: [], modelName: null, status: "pending_review", statusDetail: null, consent: null, rawCarts: [], audit: [],
  }));

describe("queue at volume", () => {
  it("grouping by match gives 3 groups, most urgent first, losing nothing", () => {
    const g = groupProposals(views, "match");
    expect(g.length).toBe(3);
    expect(g.reduce((s, x) => s + x.items.length, 0)).toBe(views.length);
    const firstDeadlines = g.map((x) => x.items[0].proposal!.expiresAt);
    expect([...firstDeadlines].sort()).toEqual(firstDeadlines);
  });

  it("match x section groups never mix sections", () => {
    for (const grp of groupProposals(views, "match_section")) {
      expect(new Set(grp.items.map((p) => p.proposal!.facts.section)).size).toBe(1);
    }
  });

  it("summaries keep ticket discount, voucher worst case and perks apart", () => {
    for (const grp of groupProposals(views, "offer")) {
      const type = grp.items[0].proposal!.offer.type;
      if (type !== "promo_code") expect(grp.summary.ticketDiscountCents).toBe(0);
      if (type !== "merch_addon") expect(grp.summary.merchVoucherMaxCents).toBe(0);
      if (type !== "perk") expect(grp.summary.perks).toBe(0);
    }
  });

  it("filters combine (AND) and search matches fan or cart ID", () => {
    const reminders = applyFilters(views, { ...DEFAULT_FILTERS, offer: "reminder" });
    expect(reminders.every((p) => p.proposal!.offer.type === "reminder")).toBe(true);
    const emailReminders = applyFilters(views, { ...DEFAULT_FILTERS, offer: "reminder", channel: "email" });
    expect(emailReminders.length).toBeLessThanOrEqual(reminders.length);
    expect(emailReminders.every((p) => p.proposal!.channel === "email")).toBe(true);
    const one = views[0];
    expect(applyFilters(views, { ...DEFAULT_FILTERS, q: one.fanId!.toLowerCase() }).map((p) => p.id)).toContain(one.id);
    expect(applyFilters(views, { ...DEFAULT_FILTERS, q: one.cartIds[0] }).map((p) => p.id)).toContain(one.id);
  });

  it("no grouping keeps the deadline order", () => {
    expect(groupProposals(views, "none")[0].items).toEqual(views);
  });
});
