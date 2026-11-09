import { describe, expect, it } from "vitest";
import { decide } from "@/engine/decide";
import { DEFAULT_TENANTS } from "@/engine/tenants";
import { SAMPLE_AS_OF, SAMPLE_CARTS, SAMPLE_FAN_ACCOUNTS } from "@/engine/data/sample-carts";
import { draftCopy } from "@/engine/copy/draft";
import { lintCopy, PROMO_PLACEHOLDER } from "@/engine/copy/lint";
import { ClaudeAgentCopyModel, type CopyModel } from "@/engine/copy/model";
import { templateCopy } from "@/engine/copy/templates";
import type { Channel, Offer } from "@/engine/types";

const run = decide({ carts: SAMPLE_CARTS, fanAccounts: SAMPLE_FAN_ACCOUNTS, contactHistory: [], tenants: DEFAULT_TENANTS, asOf: SAMPLE_AS_OF });
const proposals = run.decisions.filter((d) => d.outcome === "propose");
const reminder = proposals.find((d) => d.proposal!.offer.type === "reminder")!;
const merch = proposals.find((d) => d.proposal!.offer.type === "merch_addon")!;

const fake = (impl: (signal: AbortSignal) => Promise<unknown>): CopyModel => ({ name: "fake", draft: (_r, s) => impl(s) });

describe("templates always pass the linter", () => {
  const facts = proposals[0].proposal!.facts;
  const offers: Offer[] = [
    { type: "reminder" },
    { type: "promo_code", percentOff: 10, singleUse: true },
    { type: "promo_code", percentOff: 15, singleUse: true },
    { type: "merch_addon", percentOff: 10, maxValueCents: 1000, singleUse: true },
    { type: "perk", perkId: "p", label: "Pre-match pitch-side access for your group" },
  ];
  for (const offer of offers)
    for (const channel of (offer.type === "perk" ? ["sales_task"] : ["email", "push"]) as Channel[]) {
      it(`${offer.type} via ${channel}`, () => expect(lintCopy(templateCopy(offer, channel, facts), offer, channel, facts)).toEqual([]));
    }
  it("for every sample proposal", () => {
    for (const d of proposals) {
      const p = d.proposal!;
      expect(lintCopy(templateCopy(p.offer, p.channel, p.facts), p.offer, p.channel, p.facts)).toEqual([]);
    }
  });
});

describe("linter catches what a model gets wrong", () => {
  const f = reminder.proposal!.facts;
  it("a discount on a no-discount reminder", () =>
    expect(lintCopy({ subject: "Come back!", body: "Finish your order and get 10% off your seats." }, { type: "reminder" }, "push", f).join()).toMatch(/discount/));
  it("a different % than the offer", () =>
    expect(lintCopy({ subject: "15% off", body: `Use ${PROMO_PLACEHOLDER}` }, { type: "promo_code", percentOff: 10, singleUse: true }, "email", f).join()).toMatch(/10%/));
  it("invented scarcity numbers", () =>
    expect(lintCopy({ subject: "Hurry", body: "Only 3 seats left in your section!" }, { type: "reminder" }, "push", f).join()).toMatch(/not in the facts/));
  it("numbered talking points are not invented facts (live Claude false positive), but a scarcity claim inside one still is", () => {
    const perk = proposals.find((d) => d.proposal!.offer.type === "perk")!.proposal!;
    const ok = { subject: "Call about 6 Club seats", body: "1. Thank them for 40 tickets.\n2. Offer pitch-side access.\n3. Help finish checkout." };
    expect(lintCopy(ok, perk.offer, "sales_task", perk.facts)).toEqual([]);
    const bad = { subject: "Call about 6 Club seats", body: "1. Tell them only 3 Club seats are left." };
    expect(lintCopy(bad, perk.offer, "sales_task", perk.facts).join()).toMatch(/not in the facts: 3/);
  });
  it("pressure language", () =>
    expect(lintCopy({ subject: "Last chance", body: "Your seats are in your cart." }, { type: "reminder" }, "email", f).join()).toMatch(/pressure/));
  it("a literal code instead of the placeholder", () =>
    expect(lintCopy({ subject: "Bonus", body: "Get 10% off with SEAWOLF10X" }, merch.proposal!.offer, "push", f).join()).toMatch(/placeholder|PROMO_CODE/));
  it("prices", () =>
    expect(lintCopy({ subject: "Your seats", body: "Your seats for $96 are waiting." }, { type: "reminder" }, "email", f).join()).toMatch(/price/));
});

describe("draftCopy: model output is used only if it passes schema and lint", () => {
  it("uses valid model copy", async () => {
    const r = await draftCopy(reminder, fake(async () => ({ subject: "Your seats are waiting", body: "Your 2 seats are still in your cart. Tap to finish before kickoff." })));
    expect(r.source).toBe("model");
  });
  it("falls back when the model breaks a rule, and records why", async () => {
    const r = await draftCopy(reminder, fake(async () => ({ subject: "Last chance!", body: "Get 20% off now" })));
    expect(r.source).toBe("template");
    expect(r.fallbackReason).toBe("lint_failed");
    expect(r.notes.length).toBeGreaterThan(0);
  });
  it("falls back on bad JSON shape", async () => {
    const r = await draftCopy(reminder, fake(async () => ({ text: "hi" })));
    expect(r.fallbackReason).toBe("schema_invalid");
  });
  it("falls back on model error", async () => {
    const r = await draftCopy(reminder, fake(async () => { throw new Error("401 not logged in"); }));
    expect(r.fallbackReason).toBe("model_error");
  });
  it("falls back on timeout", async () => {
    const r = await draftCopy(reminder, fake((s) => new Promise((_, rej) => s.addEventListener("abort", () => rej(new Error("aborted"))))), 50);
    expect(r.fallbackReason).toBe("model_timeout");
  });
  it("works with the model switched off", async () => {
    expect((await draftCopy(reminder, null)).fallbackReason).toBe("model_disabled");
  });
});

// Live call through the Claude Agent SDK. Opt-in: LIVE_MODEL=1 npm test
describe.runIf(process.env.LIVE_MODEL === "1")("live Claude copy", () => {
  it("drafts lint-clean copy for every sample proposal", { timeout: 240_000 }, async () => {
    const model = new ClaudeAgentCopyModel();
    const results = await Promise.all(proposals.map((d) => draftCopy(d, model, 120_000)));
    for (const [i, r] of results.entries()) console.log(proposals[i].key, r.source, r.fallbackReason, r.notes, JSON.stringify(r.copy));
    expect(results.filter((r) => r.source === "model").length).toBeGreaterThan(0);
  });
});
