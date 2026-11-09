import { DAY_MS } from "./normalize";
import { POLICY } from "./policy";
import { PLATFORM_MAX_PROMO_PCT } from "./tenants";
import type { ContactRecord, Decision, GuardrailViolation, TenantConfig } from "./types";

export interface GuardrailContext {
  tenant: TenantConfig;
  /** Consent as of *now* (re-read from the fan record at send time, not copied from the run). */
  consent: { email: boolean; push: boolean };
  asOf: string;
  contactHistory: ContactRecord[];
}

/**
 * Independent second check. It doesn't trust decide(). It runs:
 *  1. right after decide() (a violation there is an engine bug → alert),
 *  2. on every marketer edit (the UI can't save an edit that violates it),
 *  3. at send time, against fresh consent and contact history.
 */
export function checkProposal(d: Decision, ctx: GuardrailContext): GuardrailViolation[] {
  const v: GuardrailViolation[] = [];
  const p = d.proposal;
  if (!p) return v;
  const asOfMs = Date.parse(ctx.asOf);

  if (!ctx.tenant.offersEnabled || ctx.tenant.tenantId !== d.tenantId) {
    v.push({ code: "TENANT_NOT_ENABLED", message: `Offers are not enabled for ${ctx.tenant.teamName}.` });
  }

  if (p.offer.type === "promo_code" || p.offer.type === "merch_addon") {
    const cap = Math.min(ctx.tenant.maxPromoPct, PLATFORM_MAX_PROMO_PCT);
    if (!(p.offer.percentOff > 0 && p.offer.percentOff <= cap && Number.isInteger(p.offer.percentOff))) {
      v.push({ code: "PROMO_OVER_CAP", message: `Discount must be a whole number from 1 to ${cap}%. Got ${p.offer.percentOff}%.` });
    }
    if (p.offer.singleUse !== true) v.push({ code: "PROMO_NOT_SINGLE_USE", message: "Promo codes must be single-use." });
  }
  if (p.offer.type === "merch_addon") {
    const max = ctx.tenant.merchAddonMaxCents;
    if (!(Number.isInteger(p.offer.maxValueCents) && p.offer.maxValueCents > 0 && p.offer.maxValueCents <= max)) {
      v.push({ code: "MERCH_OVER_CAP", message: `A merch voucher must be capped at $${max / 100} or less.` });
    }
  }

  if ((p.offer.type === "perk") !== (p.channel === "sales_task")) {
    v.push({ code: "CHANNEL_OFFER_MISMATCH", message: "Perks go through the salesperson (sales task) only, and sales tasks carry a perk." });
  }

  if ((p.channel === "email" && !ctx.consent.email) || (p.channel === "push" && !ctx.consent.push)) {
    v.push({ code: "CHANNEL_NOT_CONSENTED", message: `The fan has not opted in to ${p.channel}.` });
  }

  if (asOfMs >= Date.parse(p.expiresAt)) v.push({ code: "EXPIRED", message: "Too close to kickoff (or past it). The offer has expired." });

  const mine = ctx.contactHistory.filter((h) => h.tenantId === d.tenantId && h.fanId === d.fanId);
  const sameMatch = mine.filter((h) => h.matchId === d.matchId).length;
  const otherRecent = mine.some(
    (h) => h.matchId !== d.matchId && asOfMs - Date.parse(h.sentAt) < POLICY.otherMatchCooldownDays * DAY_MS && Date.parse(h.sentAt) <= asOfMs,
  );
  if (sameMatch >= p.touchNumber || otherRecent) {
    v.push({ code: "ALREADY_CONTACTED", message: "The fan has already been contacted (this touch was sent, or another offer went out recently)." });
  }
  return v;
}
