import type { Channel, Offer, OfferFacts, ReasonCode } from "./types";

/**
 * The marketer-facing reason is assembled from reason codes and facts by code, not by the model,
 * so it can never disagree with the rule that actually fired.
 */
export function describeOffer(o: Offer): string {
  switch (o.type) {
    case "reminder":
      return "Reminder (no discount)";
    case "promo_code":
      return `${o.percentOff}% off promo code (single-use)`;
    case "merch_addon":
      return `${o.percentOff}% off match-day merch, up to $${o.maxValueCents / 100} (single-use)`;
    case "perk":
      return `Perk: ${o.label}`;
  }
}

export function describeChannel(c: Channel): string {
  return c === "email" ? "Email" : c === "push" ? "In-app / push" : "Sales call (task for the salesperson)";
}

const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

export function buildReason(codes: ReasonCode[], f: Partial<OfferFacts> & { cartCount?: number }, channel?: Channel): string {
  const has = (c: ReasonCode) => codes.includes(c);
  const parts: string[] = [];

  // Gates first: if one fired, it is the whole story.
  if (has("BAD_DATA")) return "Held: a field this decision depends on (match, seats, price, or sell-through) couldn't be read. Fix the source data; nothing is sent.";
  if (has("UNKNOWN_TENANT")) return "Held: this cart's team isn't configured on the platform yet. Nothing is sent until it is.";
  if (has("TENANT_NOT_ENABLED")) return `Held: offers aren't switched on yet for this team (${f.teamName ?? "unknown"}). The cart is visible so data can be checked, but it can't be approved.`;
  if (has("UNRESOLVED_IDENTITY")) return "Held: guest checkout whose email doesn't match exactly one fan account. We don't guess who the person is.";
  if (has("MATCH_ALREADY_PLAYED")) return "No offer: the match has already been played.";
  if (has("MATCH_TOO_SOON")) return "No offer: kickoff is only a few hours away, too late for a considered send.";
  if (has("NO_CONSENTED_CHANNEL")) return "No offer: the fan has opted out of both email and push.";
  if (has("RECENTLY_CONTACTED")) return "No offer: the fan got an offer about another match in the last 7 days. Frequency cap.";
  if (has("OTHER_OFFER_THIS_RUN")) return "No offer: this fan already has a proposal for another match in this run. One offer per fan at a time.";
  if (has("ALREADY_CONTACTED_FOR_MATCH")) return "No offer: the fan was already contacted about this match, and a follow-up isn't warranted (too recent, already discounted, or the section is selling).";

  if (has("MERGED_DUPLICATE_CARTS")) parts.push(`${f.cartCount ?? 2} carts for the same match were merged into one decision, so the fan gets one message, not several`);
  if (has("GUEST_MATCHED_BY_EMAIL")) parts.push("a guest checkout matched this fan's account by exact email");

  if (has("SEASON_PASS_HOLDER")) parts.push(`season-pass holder${f.lifetimeTickets != null ? ` with ${f.lifetimeTickets} lifetime tickets` : ""}`);
  else if (has("NEW_FAN")) parts.push("first-time buyer");
  else if (has("LAPSED_FAN")) parts.push(`lapsed fan (last bought ${f.daysSinceLastPurchase != null ? days(f.daysSinceLastPurchase) : "a long time"} ago)`);
  else if (has("REGULAR_FAN")) parts.push(`regular buyer (${f.lifetimeTickets ?? "?"} tickets, last ${f.daysSinceLastPurchase != null ? days(f.daysSinceLastPurchase) : "?"} ago)`);

  if (has("HIGH_SELL_THROUGH")) parts.push(`${f.section} is ${f.sectionSoldPct}% sold, so these seats sell at full price and a ticket discount would give revenue away`);
  else if (has("LOW_SELL_THROUGH")) parts.push(`${f.section} is only ${f.sectionSoldPct}% sold with ${days(f.daysToKickoff ?? 0)} to go`);

  if (has("ESCALATED_SECOND_TOUCH")) parts.push("a full-price reminder 3+ days ago didn't convert and the section is still soft, so a small single-use discount now earns a sale that would otherwise go empty");
  else if (has("LOW_SELL_THROUGH") && !has("SEASON_PASS_HOLDER")) parts.push("first touch is full price; if it doesn't convert in 72 hours the engine will propose a promo");

  if (channel === "sales_task") parts.push("best handled personally by the salesperson, not an automated message");
  else if (has("CHANNEL_FROM_RECENT_SOURCE")) parts.push(`${channel === "push" ? "push" : "email"} because their latest cart was on the ${f.latestSource === "app" ? "app" : "web"}`);
  else if (has("CHANNEL_FALLBACK_CONSENT")) parts.push(`${channel === "push" ? "push" : "email"} because it's the only channel they've opted into`);

  const s = parts.join("; ");
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}
