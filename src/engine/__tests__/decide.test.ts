/**
 * Encodes SPEC.md §5 (expected decisions for the sample) and §6 (invariants).
 * These tests were written before the engine; the engine is built to pass them.
 */
import { describe, expect, it } from "vitest";
import { decide } from "@/engine/decide";
import { checkProposal } from "@/engine/guardrails";
import { DEFAULT_TENANTS } from "@/engine/tenants";
import { SAMPLE_AS_OF, SAMPLE_CARTS, SAMPLE_FAN_ACCOUNTS, type RawCartRow } from "@/engine/data/sample-carts";
import type { Decision, EngineInput } from "@/engine/types";
import { costTotal } from "@/engine/offers";

const ticketDiscount = (d: Decision) => costTotal(d.proposal!.costs, "ticket_discount");

const baseInput = (over: Partial<EngineInput> = {}): EngineInput => ({
  carts: SAMPLE_CARTS,
  fanAccounts: SAMPLE_FAN_ACCOUNTS,
  contactHistory: [],
  tenants: DEFAULT_TENANTS,
  asOf: SAMPLE_AS_OF,
  ...over,
});

const byCart = (decisions: Decision[], cartId: string) => {
  const d = decisions.find((x) => x.cartIds.includes(cartId));
  if (!d) throw new Error(`no decision for ${cartId}`);
  return d;
};

describe("sample carts: expected decisions (SPEC §5)", () => {
  const run = decide(baseInput());

  it("F-204: merges C-1001 + C-1006 into one push reminder, no discount", () => {
    const d = byCart(run.decisions, "C-1001");
    expect(d.cartIds.sort()).toEqual(["C-1001", "C-1006"]);
    expect(d.fanId).toBe("F-204");
    expect(d.outcome).toBe("propose");
    expect(d.proposal?.offer).toEqual({ type: "reminder" });
    expect(d.proposal?.channel).toBe("push"); // most recent cart was App, push opted in
    expect(ticketDiscount(d)).toBe(0);
    expect(d.reasonCodes).toEqual(expect.arrayContaining(["MERGED_DUPLICATE_CARTS", "HIGH_SELL_THROUGH"]));
  });

  it("F-511: guest C-1008 is linked by exact email; first touch is a full-price reminder by email", () => {
    const d = byCart(run.decisions, "C-1008");
    expect(d.cartIds.sort()).toEqual(["C-1002", "C-1008"]);
    expect(d.fanId).toBe("F-511");
    expect(d.outcome).toBe("propose");
    expect(d.proposal?.offer).toEqual({ type: "reminder" }); // SPEC §4a: a discount is never the first touch
    expect(d.proposal?.channel).toBe("email"); // push not consented
    expect(ticketDiscount(d)).toBe(0);
    expect(d.reasonCodes).toEqual(expect.arrayContaining(["GUEST_MATCHED_BY_EMAIL", "LOW_SELL_THROUGH", "NEW_FAN"]));
  });

  it("F-092: lapsed fan in a high-demand section gets merch add-on by push, no ticket discount", () => {
    const d = byCart(run.decisions, "C-1003");
    expect(d.outcome).toBe("propose");
    expect(d.proposal?.offer).toEqual({ type: "merch_addon", percentOff: 10, maxValueCents: 1000, singleUse: true });
    expect(d.proposal?.channel).toBe("push"); // email opted out
    expect(d.reasonCodes).toEqual(expect.arrayContaining(["LAPSED_FAN", "HIGH_SELL_THROUGH"]));
  });

  it("F-333: season-pass holder in a 97% section gets a non-price perk via the salesperson", () => {
    const d = byCart(run.decisions, "C-1004");
    expect(d.outcome).toBe("propose");
    expect(d.proposal?.offer).toMatchObject({ type: "perk", perkId: "pitchside-access" });
    expect(d.proposal?.channel).toBe("sales_task");
    expect(ticketDiscount(d)).toBe(0);
    expect(d.reasonCodes).toContain("SEASON_PASS_HOLDER");
  });

  it("C-1005: match already played is suppressed", () => {
    const d = byCart(run.decisions, "C-1005");
    expect(d.outcome).toBe("suppress");
    expect(d.reasonCodes).toContain("MATCH_ALREADY_PLAYED");
    expect(d.proposal).toBeUndefined();
  });

  it("C-1007: onboarding league team is held, and the unsynced shop data is logged", () => {
    const d = byCart(run.decisions, "C-1007");
    expect(d.outcome).toBe("hold");
    expect(d.reasonCodes).toContain("TENANT_NOT_ENABLED");
    expect(run.dataIssues).toContainEqual(
      expect.objectContaining({ cartId: "C-1007", field: "shopSpend12mo", issue: "not_synced" }),
    );
  });

  it("produces exactly 4 proposals, 1 suppression, 1 hold", () => {
    const count = (o: Decision["outcome"]) => run.decisions.filter((d) => d.outcome === o).length;
    expect([count("propose"), count("suppress"), count("hold")]).toEqual([4, 1, 1]);
  });

  it("every decision has a non-empty marketer-readable reason", () => {
    for (const d of run.decisions) expect(d.reason.length).toBeGreaterThan(20);
  });
});

describe("gates", () => {
  it("a guest cart with no exact email match is held, not guessed", () => {
    const carts = [{ ...SAMPLE_CARTS[7], checkoutEmail: "someone-else@example.com" }];
    const d = decide(baseInput({ carts })).decisions[0];
    expect(d.outcome).toBe("hold");
    expect(d.reasonCodes).toContain("UNRESOLVED_IDENTITY");
  });

  it("a fan contacted about a different match in the last 7 days is suppressed", () => {
    const contactHistory = [
      { tenantId: "seawolves", fanId: "F-511", matchId: "some-other-match", channel: "email" as const, offerType: "reminder" as const, sentAt: "2026-11-06T10:00:00-08:00" },
    ];
    const d = byCart(decide(baseInput({ contactHistory })).decisions, "C-1002");
    expect(d.outcome).toBe("suppress");
    expect(d.reasonCodes).toContain("RECENTLY_CONTACTED");
  });
});

describe("discount escalation: second touch only (SPEC §4a)", () => {
  const matchOf = (cartId: string) => byCart(decide(baseInput()).decisions, cartId).matchId;
  const reminderFor = (fanId: string, cartId: string, sentAt: string, offerType: "reminder" | "promo_code" = "reminder") => [
    { tenantId: "seawolves", fanId, matchId: matchOf(cartId), channel: "email" as const, offerType, sentAt },
  ];

  it("F-511: an unconverted reminder ≥72h ago in a soft section escalates to a 10% single-use promo", () => {
    const d = byCart(decide(baseInput({ contactHistory: reminderFor("F-511", "C-1002", "2026-11-05T10:00:00-08:00") })).decisions, "C-1002");
    expect(d.outcome).toBe("propose");
    expect(d.proposal?.offer).toEqual({ type: "promo_code", percentOff: 10, singleUse: true });
    expect(d.proposal?.channel).toBe("email");
    expect(ticketDiscount(d)).toBe(1400);
    expect(d.reasonCodes).toContain("ESCALATED_SECOND_TOUCH");
  });

  it("same export re-evaluated 4 days later (asOf moves, exportedAt fixed) escalates F-511", () => {
    const contactHistory = reminderFor("F-511", "C-1002", SAMPLE_AS_OF);
    const later = new Date(Date.parse(SAMPLE_AS_OF) + 4 * 86_400_000).toISOString();
    const d = byCart(decide(baseInput({ contactHistory, asOf: later, exportedAt: SAMPLE_AS_OF })).decisions, "C-1002");
    expect(d.proposal?.offer).toEqual({ type: "promo_code", percentOff: 10, singleUse: true });
    expect(d.proposal?.facts.daysToKickoff).toBe(14);
  });

  it("a reminder less than 72h ago is not followed up yet", () => {
    const d = byCart(decide(baseInput({ contactHistory: reminderFor("F-511", "C-1002", "2026-11-08T10:00:00-08:00") })).decisions, "C-1002");
    expect(d.outcome).toBe("suppress");
    expect(d.reasonCodes).toContain("ALREADY_CONTACTED_FOR_MATCH");
  });

  it("no third touch: a promo already sent for this match means nothing more", () => {
    const d = byCart(decide(baseInput({ contactHistory: reminderFor("F-511", "C-1002", "2026-11-01T10:00:00-08:00", "promo_code") })).decisions, "C-1002");
    expect(d.outcome).toBe("suppress");
    expect(d.reasonCodes).toContain("ALREADY_CONTACTED_FOR_MATCH");
  });

  it("no escalation in a high-demand section (F-204, Lower Bowl 88%)", () => {
    const d = byCart(decide(baseInput({ contactHistory: reminderFor("F-204", "C-1001", "2026-11-05T10:00:00-08:00") })).decisions, "C-1001");
    expect(d.outcome).toBe("suppress");
    expect(d.reasonCodes).toContain("ALREADY_CONTACTED_FOR_MATCH");
  });

  it("a fan opted out of both channels gets nothing (non-season-pass)", () => {
    const carts = [{ ...SAMPLE_CARTS[0], emailOptIn: "No", pushOptIn: "No" }];
    const d = decide(baseInput({ carts })).decisions[0];
    expect(d.outcome).toBe("suppress");
    expect(d.reasonCodes).toContain("NO_CONSENTED_CHANNEL");
  });

  it("enabling a tenant is a config change, not a code change", () => {
    const tenants = DEFAULT_TENANTS.map((t) => ({ ...t, offersEnabled: true }));
    const d = byCart(decide(baseInput({ tenants })).decisions, "C-1007");
    expect(d.outcome).toBe("propose");
  });
});

describe("guardrails (independent second check, also run on marketer edits and at send time)", () => {
  const firstRun = decide(baseInput());
  const contactHistory = [
    { tenantId: "seawolves", fanId: "F-511", matchId: byCart(firstRun.decisions, "C-1002").matchId, channel: "email" as const, offerType: "reminder" as const, sentAt: "2026-11-05T10:00:00-08:00" },
  ];
  const promo = byCart(decide(baseInput({ contactHistory })).decisions, "C-1002");
  const tenant = DEFAULT_TENANTS.find((t) => t.tenantId === "seawolves")!;
  // contactHistory here is what the send-time check sees; the earlier reminder is allowed (it's the first touch).
  const ctx = { tenant, consent: { email: true, push: false }, asOf: SAMPLE_AS_OF, contactHistory };

  it("passes the engine's own escalated promo", () => {
    expect(promo.proposal?.offer.type).toBe("promo_code");
    expect(checkProposal(promo, ctx)).toEqual([]);
  });

  it("blocks a send when this idempotency key was already sent (double-approve / retry)", () => {
    const sent = [...contactHistory, { ...contactHistory[0], offerType: "promo_code" as const, sentAt: "2026-11-09T11:00:00-08:00" }];
    expect(checkProposal(promo, { ...ctx, contactHistory: sent }).map((v) => v.code)).toContain("ALREADY_CONTACTED");
  });

  it("rejects a promo edited above 15%", () => {
    const edited = { ...promo, proposal: { ...promo.proposal!, offer: { type: "promo_code" as const, percentOff: 20, singleUse: true as const } } };
    expect(checkProposal(edited, ctx).map((v) => v.code)).toContain("PROMO_OVER_CAP");
  });

  it("rejects a channel switch to one the fan opted out of", () => {
    const edited = { ...promo, proposal: { ...promo.proposal!, channel: "push" as const } };
    expect(checkProposal(edited, ctx).map((v) => v.code)).toContain("CHANNEL_NOT_CONSENTED");
  });

  it("rejects a send after expiry", () => {
    expect(checkProposal(promo, { ...ctx, asOf: "2026-12-31T00:00:00Z" }).map((v) => v.code)).toContain("EXPIRED");
  });
});

describe("invariants on generated carts (SPEC §6)", () => {
  // Small seeded PRNG so failures reproduce.
  const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
  const pick = <T,>(r: () => number, xs: T[]) => xs[Math.floor(r() * xs.length)];

  const generate = (seed: number): RawCartRow[] => {
    const r = rng(seed);
    return Array.from({ length: 60 }, (_, i) => ({
      cartId: `G-${i}`,
      fanId: pick(r, ["F-1", "F-2", "F-3", "F-4", "F-5", "Guest (no Fan ID)"]),
      team: pick(r, ["Seawolves", "Seawolves", "League team (onboarding)", "Mystery FC"]),
      source: pick(r, ["Web", "App"]),
      match: pick(r, ["Next home match (in 4 days)", "Home match (in 18 days)", "Home match (played 2 days ago)", "Home match (in 3 hrs)"]),
      seats: String(1 + Math.floor(r() * 6)),
      section: pick(r, ["Lower Bowl", "Upper Deck", "Club"]),
      sectionSoldPct: `${Math.floor(r() * 100)}%`,
      cartValue: `$${10 + Math.floor(r() * 600)}`,
      abandoned: `${1 + Math.floor(r() * 150)} hrs ago`,
      lifetimeTickets: pick(r, ["0", "3", "14", "40", "Unknown"]),
      lastPurchase: pick(r, ["Never", "9 days ago", "200 days ago", "Unknown"]),
      shopSpend12mo: pick(r, ["$0", "$120", "Not synced", "Unknown"]),
      seasonPass: pick(r, ["Yes", "No", "No", "No"]),
      emailOptIn: pick(r, ["Yes", "No"]),
      pushOptIn: pick(r, ["Yes", "No"]),
      checkoutEmail: pick(r, ["f1@example.com", "nobody@example.com", undefined]),
    }));
  };
  // Only F-1's email is ever used on a guest cart, so some guests resolve and some must be held.
  const accounts = [
    { fanId: "F-1", email: "f1@example.com" },
    ...["F-2", "F-3", "F-4", "F-5"].map((id) => ({ fanId: id, email: `${id.toLowerCase()}@example.com` })),
  ];

  for (const seed of [1, 2, 3, 42, 1337]) {
    it(`seed ${seed}: every cart decided once, one proposal per fan, consent and caps respected`, () => {
      const carts = generate(seed);
      const run = decide(baseInput({ carts, fanAccounts: accounts }));

      // 1. every cart in exactly one decision
      const seen = run.decisions.flatMap((d) => d.cartIds).sort();
      expect(seen).toEqual(carts.map((c) => c.cartId).sort());

      const proposals = run.decisions.filter((d) => d.outcome === "propose");
      // guard against a vacuous pass: the generator must exercise every outcome
      expect(proposals.length).toBeGreaterThan(0);
      expect(run.decisions.some((d) => d.outcome === "hold")).toBe(true);
      expect(run.decisions.some((d) => d.outcome === "suppress")).toBe(true);
      // 2. one proposal per fan
      const fans = proposals.map((d) => `${d.tenantId}:${d.fanId}`);
      expect(new Set(fans).size).toBe(fans.length);

      for (const d of proposals) {
        const p = d.proposal!;
        // 4. caps
        if (p.offer.type === "promo_code" || p.offer.type === "merch_addon") {
          expect(p.offer.percentOff).toBeLessThanOrEqual(15);
          expect(p.offer.singleUse).toBe(true);
        }
        // 5. tenant enabled
        expect(DEFAULT_TENANTS.find((t) => t.tenantId === d.tenantId)?.offersEnabled).toBe(true);
        // 3. channel consented on every cart in the group
        for (const id of d.cartIds) {
          const c = carts.find((x) => x.cartId === id)!;
          if (p.channel === "email") expect(c.emailOptIn).toBe("Yes");
          if (p.channel === "push") expect(c.pushOptIn).toBe("Yes");
        }
      }
      // 6. deterministic
      expect(decide(baseInput({ carts, fanAccounts: accounts }))).toEqual(run);
    });
  }
});
