/**
 * Offer costs as typed lines (not one "discount" number). A ticket discount is lost ticket revenue,
 * known exactly. A merch voucher costs shop margin, known only as a capped worst case. A perk isn't
 * money. They must never be added into one misleading figure.
 */
import { describe, expect, it } from "vitest";
import { decide } from "@/engine/decide";
import { checkProposal } from "@/engine/guardrails";
import { costsOf, costTotal } from "@/engine/offers";
import { lintCopy } from "@/engine/copy/lint";
import { templateCopy } from "@/engine/copy/templates";
import { DEFAULT_TENANTS } from "@/engine/tenants";
import { SAMPLE_AS_OF, SAMPLE_CARTS, SAMPLE_FAN_ACCOUNTS } from "@/engine/data/sample-carts";
import type { Decision, Offer } from "@/engine/types";

const run = decide({ carts: SAMPLE_CARTS, fanAccounts: SAMPLE_FAN_ACCOUNTS, contactHistory: [], tenants: DEFAULT_TENANTS, asOf: SAMPLE_AS_OF });
const byCart = (id: string) => run.decisions.find((d) => d.cartIds.includes(id))!;
const seawolves = DEFAULT_TENANTS.find((t) => t.tenantId === "seawolves")!;
const merch: Offer = { type: "merch_addon", percentOff: 10, maxValueCents: 1000, singleUse: true };

describe("costsOf: every offer type declares its own cost lines", () => {
  it("reminder costs nothing", () => expect(costsOf({ type: "reminder" }, 9600)).toEqual([]));

  it("ticket promo is an exact ticket discount", () =>
    expect(costsOf({ type: "promo_code", percentOff: 10, singleUse: true }, 14000)).toEqual([
      expect.objectContaining({ kind: "ticket_discount", basis: "exact", amountCents: 1400 }),
    ]));

  it("merch voucher is a capped worst case, not a ticket discount", () =>
    expect(costsOf(merch, 5800)).toEqual([expect.objectContaining({ kind: "merch_voucher", basis: "max", amountCents: 1000 })]));

  it("perk is non-monetary", () =>
    expect(costsOf({ type: "perk", perkId: "pitchside-access", label: "Pitch-side access" }, 54000)).toEqual([
      expect.objectContaining({ kind: "perk", basis: "non_monetary", amountCents: null }),
    ]));

  it("totals are per kind, never mixed", () => {
    const lines = [...costsOf({ type: "promo_code", percentOff: 10, singleUse: true }, 14000), ...costsOf(merch, 5800)];
    expect(costTotal(lines, "ticket_discount")).toBe(1400);
    expect(costTotal(lines, "merch_voucher")).toBe(1000);
  });
});

describe("sample: F-092's card no longer reads 'Discount $0'", () => {
  it("F-092's merch voucher carries the tenant's cap and a $10 worst-case cost line", () => {
    const p = byCart("C-1003").proposal!;
    expect(p.offer).toEqual({ type: "merch_addon", percentOff: 10, maxValueCents: seawolves.merchAddonMaxCents, singleUse: true });
    expect(p.costs).toEqual([expect.objectContaining({ kind: "merch_voucher", basis: "max", amountCents: 1000 })]);
    expect(costTotal(p.costs, "ticket_discount")).toBe(0);
  });
});

describe("guardrail: merch voucher must be capped by the tenant", () => {
  const d = byCart("C-1003");
  const ctx = { tenant: seawolves, consent: { email: false, push: true }, asOf: SAMPLE_AS_OF, contactHistory: [] };
  const withOffer = (offer: Offer): Decision => ({ ...d, proposal: { ...d.proposal!, offer, costs: costsOf(offer, d.proposal!.cartValueCents) } });

  it("passes at the cap", () => expect(checkProposal(d, ctx)).toEqual([]));
  it("rejects a cap above the tenant's", () =>
    expect(checkProposal(withOffer({ ...merch, maxValueCents: 5000 }), ctx).map((v) => v.code)).toContain("MERCH_OVER_CAP"));
  it("rejects an uncapped voucher", () =>
    expect(checkProposal(withOffer({ ...merch, maxValueCents: 0 }), ctx).map((v) => v.code)).toContain("MERCH_OVER_CAP"));
});

describe("copy: the fan is told the cap", () => {
  const f = byCart("C-1003").proposal!.facts;
  it("templates state it and pass lint", () => {
    for (const ch of ["email", "push"] as const) {
      const c = templateCopy(merch, ch, f);
      expect(`${c.subject} ${c.body}`).toContain("$10");
      expect(lintCopy(c, merch, ch, f)).toEqual([]);
    }
  });
  it("copy that hides the cap fails", () =>
    expect(lintCopy({ subject: "Match-day bonus", body: "Finish your ticket and get 10% off in the shop with {{PROMO_CODE}}." }, merch, "push", f).join()).toMatch(/up to \$10/));
  it("copy with a different cap fails", () =>
    expect(lintCopy({ subject: "Match-day bonus", body: "10% off in the shop, up to $25, with {{PROMO_CODE}}." }, merch, "push", f).join()).toMatch(/price|\$10/));
});
