import { costTotal } from "@/engine/offers";
import type { Channel, Offer } from "@/engine/types";
import type { ProposalView } from "@/server/service";

/**
 * Pure helpers for reviewing the queue at volume: filter, group, and summarize.
 * Kept out of the component so they can be tested.
 */
export type GroupBy = "none" | "match" | "match_section" | "offer";
export type Segment = "SEASON_PASS_HOLDER" | "NEW_FAN" | "LAPSED_FAN" | "REGULAR_FAN";

export interface Filters {
  offer: "all" | Offer["type"];
  channel: "all" | Channel;
  segment: "all" | Segment;
  /** Matches fan ID or cart ID, case-insensitive. */
  q: string;
}

export const DEFAULT_FILTERS: Filters = { offer: "all", channel: "all", segment: "all", q: "" };

export function applyFilters(ps: ProposalView[], f: Filters): ProposalView[] {
  const q = f.q.trim().toLowerCase();
  return ps.filter(
    (p) =>
      (f.offer === "all" || p.proposal?.offer.type === f.offer) &&
      (f.channel === "all" || p.proposal?.channel === f.channel) &&
      (f.segment === "all" || p.reasonCodes.includes(f.segment)) &&
      (!q || (p.fanId ?? "").toLowerCase().includes(q) || p.cartIds.some((c) => c.toLowerCase().includes(q))),
  );
}

export interface GroupSummary {
  count: number;
  cartValueCents: number;
  /** Kept apart, as on the cards: lost ticket revenue vs worst-case voucher cost vs perks. */
  ticketDiscountCents: number;
  merchVoucherMaxCents: number;
  perks: number;
}

export interface Group {
  key: string;
  label: string;
  items: ProposalView[];
  summary: GroupSummary;
}

const OFFER_LABEL: Record<Offer["type"], string> = { reminder: "Reminders", promo_code: "Ticket promo codes", merch_addon: "Merch vouchers", perk: "Perks (sales calls)" };

const matchLabel = (kickoffAt: string) =>
  `Match ${new Date(kickoffAt).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}`;

export function summarize(items: ProposalView[]): GroupSummary {
  const costs = items.flatMap((p) => p.proposal?.costs ?? []);
  return {
    count: items.length,
    cartValueCents: items.reduce((s, p) => s + (p.proposal?.cartValueCents ?? 0), 0),
    ticketDiscountCents: costTotal(costs, "ticket_discount"),
    merchVoucherMaxCents: costTotal(costs, "merch_voucher"),
    perks: costs.filter((c) => c.kind === "perk").length,
  };
}

/** Groups keep the input order inside; groups themselves are ordered by their most urgent deadline. */
export function groupProposals(ps: ProposalView[], by: GroupBy): Group[] {
  if (by === "none") return [{ key: "all", label: "All", items: ps, summary: summarize(ps) }];
  const map = new Map<string, { label: string; items: ProposalView[] }>();
  for (const p of ps) {
    const pr = p.proposal;
    if (!pr) continue;
    const [key, label] =
      by === "match"
        ? [p.matchId, matchLabel(pr.facts.kickoffAt)]
        : by === "match_section"
          ? [`${p.matchId}|${pr.facts.section}`, `${matchLabel(pr.facts.kickoffAt)} · ${pr.facts.section}`]
          : [pr.offer.type, OFFER_LABEL[pr.offer.type]];
    if (!map.has(key)) map.set(key, { label, items: [] });
    map.get(key)!.items.push(p);
  }
  const soonest = (g: { items: ProposalView[] }) => g.items.map((p) => p.proposal!.expiresAt).sort()[0] ?? "";
  return [...map.entries()]
    .sort(([ka, a], [kb, b]) => soonest(a).localeCompare(soonest(b)) || ka.localeCompare(kb))
    .map(([key, g]) => ({ key, label: g.label, items: g.items, summary: summarize(g.items) }));
}
