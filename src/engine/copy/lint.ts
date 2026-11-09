import { z } from "zod";
import type { Channel, Offer, OfferFacts } from "../types";

/** Placeholder the delivery layer replaces with a freshly minted single-use code at send time. */
export const PROMO_PLACEHOLDER = "{{PROMO_CODE}}";

export const LIMITS: Record<Channel, { subject: number; body: number }> = {
  email: { subject: 70, body: 700 },
  push: { subject: 45, body: 140 },
  sales_task: { subject: 90, body: 900 },
};

export const MessageCopySchema = z.object({
  subject: z.string().trim().min(3),
  body: z.string().trim().min(10),
});
export type MessageCopy = z.infer<typeof MessageCopySchema>;

/** JSON schema handed to the model (kept in sync with MessageCopySchema by hand; it's two fields). */
export const MESSAGE_COPY_JSON_SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string", description: "Email subject, push title, or sales task title" },
    body: { type: "string", description: "Email body, push text, or sales call talking points" },
  },
  required: ["subject", "body"],
  additionalProperties: false,
} as const;

const DISCOUNT_WORDS = /\b(discount|% ?off|percent off|save \d|sale|promo|coupon|cheaper|deal)\b/i;
const FALSE_URGENCY = /\b(last chance|only today|today only|final hours|act now|sold out soon|guarantee[ds]?)\b/i;
const MONEY = /\$\s?\d/;

/**
 * Deterministic checks on copy, whether a model, a template, or a marketer wrote it.
 * Returns human-readable problems; empty = OK.
 */
export function lintCopy(copy: MessageCopy, offer: Offer, channel: Channel, facts: OfferFacts): string[] {
  const p: string[] = [];
  const text = `${copy.subject}\n${copy.body}`;
  const lim = LIMITS[channel];
  if (copy.subject.length > lim.subject) p.push(`Subject is ${copy.subject.length} chars (max ${lim.subject} for ${channel}).`);
  if (copy.body.length > lim.body) p.push(`Body is ${copy.body.length} chars (max ${lim.body} for ${channel}).`);

  // Sales tasks are internal talking points for the salesperson: they may cite sell-through and say
  // "don't discount". Only perks go through this channel (also enforced by guardrails).
  if (channel === "sales_task") {
    if (offer.type !== "perk") p.push("Sales tasks carry a perk, not a code or a reminder.");
    const allowedSales = new Set([facts.seats, facts.daysToKickoff, facts.sectionSoldPct, facts.lifetimeTickets ?? -1, facts.daysSinceLastPurchase ?? -1]);
    const bad = [...text.matchAll(/\b\d+\b/g)].map((m) => Number(m[0])).filter((n) => !allowedSales.has(n));
    if (bad.length) p.push(`Contains numbers not in the facts: ${[...new Set(bad)].join(", ")}.`);
    return p;
  }

  const hasCode = offer.type === "promo_code" || offer.type === "merch_addon";
  if (hasCode && !text.includes(PROMO_PLACEHOLDER)) p.push(`Must include ${PROMO_PLACEHOLDER} where the single-use code goes.`);
  if (!hasCode && text.includes(PROMO_PLACEHOLDER)) p.push(`This offer has no code; remove ${PROMO_PLACEHOLDER}.`);
  if (/\b[A-Z0-9]{6,}\b/.test(text.replace(PROMO_PLACEHOLDER, "")) && hasCode) p.push("Looks like a literal promo code. Codes are minted at send time, use the placeholder.");

  // No discount language unless the offer carries one; the % must be exactly the offer's.
  if (offer.type === "reminder" || offer.type === "perk") {
    if (DISCOUNT_WORDS.test(text) || /\d+\s?%/.test(text)) p.push("Mentions a discount, but this offer has none.");
  } else {
    const pcts = [...text.matchAll(/(\d+)\s?%/g)].map((m) => Number(m[1]));
    if (!pcts.includes(offer.percentOff)) p.push(`Must state the offer as ${offer.percentOff}%.`);
    if (pcts.some((n) => n !== offer.percentOff)) p.push(`Mentions a percentage other than ${offer.percentOff}%.`);
    if (offer.type === "merch_addon" && /\b(ticket|seat)s? (discount|% ?off)/i.test(text)) p.push("Merch add-on must not read as a ticket discount.");
  }

  if (MONEY.test(text)) p.push("Mentions a price. Prices can change before the fan clicks, so leave them out.");
  if (FALSE_URGENCY.test(text)) p.push("Uses pressure language we don't use with our fans.");
  if (offer.type === "perk") p.push("Perks are offered personally by the salesperson, not by automated message.");

  // Numbers must come from the facts (no invented "only 3 seats left").
  const allowed = new Set<number>([facts.seats, facts.daysToKickoff, hasCode ? offer.percentOff : -1]);
  const nums = [...text.replace(PROMO_PLACEHOLDER, "").matchAll(/\b\d+\b/g)].map((m) => Number(m[0]));
  const invented = nums.filter((n) => !allowed.has(n));
  if (invented.length) p.push(`Contains numbers not in the facts: ${[...new Set(invented)].join(", ")}.`);

  return p;
}
