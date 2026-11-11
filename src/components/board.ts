import type { Offer } from "@/engine/types";
import type { ProposalView } from "@/server/service";
import { summarize, type GroupSummary } from "@/components/queueView";

/**
 * The review board: instead of one long list, the queue as a small grid of slices.
 * Columns are either offer types (rows = matches) or deadline lanes (rows = offer types).
 * Pure functions, tested in __tests__/board.test.ts.
 */
export type BoardColumns = "offer" | "deadline";
export type Lane = "today" | "tomorrow" | "week" | "later";

export const LANES: { key: Lane; label: string; maxHours: number }[] = [
  { key: "today", label: "Today", maxHours: 24 },
  { key: "tomorrow", label: "Tomorrow", maxHours: 48 },
  { key: "week", label: "This week", maxHours: 24 * 7 },
  { key: "later", label: "Later", maxHours: Infinity },
];

export const OFFER_COLUMNS: { key: Offer["type"]; label: string }[] = [
  { key: "reminder", label: "Reminders" },
  { key: "promo_code", label: "Ticket promos" },
  { key: "merch_addon", label: "Merch vouchers" },
  { key: "perk", label: "Perks (sales calls)" },
];

/** Which urgency lane an offer's send-by time falls in, on the app's clock. */
export function laneOf(p: ProposalView, now: string): Lane {
  const hours = (Date.parse(p.proposal!.expiresAt) - Date.parse(now)) / 3_600_000;
  return LANES.find((l) => hours < l.maxHours)!.key;
}

const matchLabel = (kickoffAt: string) => `Match ${new Date(kickoffAt).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}`;

export interface Cell {
  key: string;
  rowKey: string;
  colKey: string;
  items: ProposalView[];
  summary: GroupSummary;
  /** Items that need a person's judgment (not routine reminders). */
  judgment: number;
  earliestDeadline: string;
}

export interface Board {
  columns: BoardColumns;
  rows: { key: string; label: string }[];
  cols: { key: string; label: string }[];
  cells: Record<string, Cell>;
}

export const cellKey = (rowKey: string, colKey: string) => `${rowKey}|${colKey}`;

export function buildBoard(ps: ProposalView[], columns: BoardColumns, now: string): Board {
  const withOffer = ps.filter((p) => p.proposal);
  const pos = (p: ProposalView): [string, string] =>
    columns === "offer" ? [p.matchId, p.proposal!.offer.type] : [p.proposal!.offer.type, laneOf(p, now)];

  const buckets = new Map<string, ProposalView[]>();
  for (const p of withOffer) {
    const k = cellKey(...pos(p));
    buckets.set(k, [...(buckets.get(k) ?? []), p]);
  }
  const cells: Record<string, Cell> = {};
  for (const [k, items] of buckets) {
    const [rowKey, colKey] = k.split("|");
    cells[k] = {
      key: k,
      rowKey,
      colKey,
      items,
      summary: summarize(items),
      judgment: items.filter((p) => !isRoutine(p)).length,
      earliestDeadline: items.map((p) => p.proposal!.expiresAt).sort()[0],
    };
  }

  let rows: { key: string; label: string }[];
  let cols: { key: string; label: string }[];
  if (columns === "offer") {
    const matches = new Map<string, { label: string; earliest: string }>();
    for (const p of withOffer) {
      const m = matches.get(p.matchId);
      if (!m || p.proposal!.expiresAt < m.earliest) matches.set(p.matchId, { label: matchLabel(p.proposal!.facts.kickoffAt), earliest: p.proposal!.expiresAt });
    }
    rows = [...matches].sort(([, a], [, b]) => a.earliest.localeCompare(b.earliest)).map(([key, m]) => ({ key, label: m.label }));
    cols = OFFER_COLUMNS;
  } else {
    rows = OFFER_COLUMNS.filter((o) => withOffer.some((p) => p.proposal!.offer.type === o.key));
    cols = LANES;
  }
  return { columns, rows, cols, cells };
}

/**
 * Routine = a pending, no-discount reminder by email or push for a fan we identified directly.
 * Everything else needs a person: discounts, perks, blocked or failed sends, guest checkouts linked by email.
 */
export function isRoutine(p: ProposalView): boolean {
  return (
    p.status === "pending_review" &&
    p.proposal?.offer.type === "reminder" &&
    p.proposal.channel !== "sales_task" &&
    !p.reasonCodes.includes("GUEST_MATCHED_BY_EMAIL")
  );
}

/** Why an item isn't routine, in a few words for the list (empty for routine items). */
export function judgmentReason(p: ProposalView): string {
  if (isRoutine(p)) return "";
  if (p.status === "failed") return "Send failed";
  if (p.status === "blocked") return "Blocked at send";
  const o = p.proposal?.offer.type;
  if (o === "promo_code") return "Ticket discount";
  if (o === "merch_addon") return "Merch voucher";
  if (o === "perk") return "Perk for a season-pass holder";
  if (p.reasonCodes.includes("GUEST_MATCHED_BY_EMAIL")) return "Guest checkout linked by email";
  return "Needs a look";
}

/** Needs-judgment items first by problem (failed, blocked), then by deadline. */
export function splitSlice(items: ProposalView[]): { routine: ProposalView[]; judgment: ProposalView[] } {
  const rank = (p: ProposalView) => (p.status === "failed" ? 0 : p.status === "blocked" ? 1 : 2);
  const byDeadline = (a: ProposalView, b: ProposalView) => (a.proposal?.expiresAt ?? "").localeCompare(b.proposal?.expiresAt ?? "") || a.id - b.id;
  return {
    routine: items.filter(isRoutine).sort(byDeadline),
    judgment: items.filter((p) => !isRoutine(p)).sort((a, b) => rank(a) - rank(b) || byDeadline(a, b)),
  };
}

/** A repeatable random sample to read before approving a batch (same slice, same sample). */
export function spotCheck(items: ProposalView[], n = 5): ProposalView[] {
  const h = (s: string) => {
    let x = 0x811c9dc5;
    for (const c of s) x = Math.imul(x ^ c.charCodeAt(0), 0x01000193) >>> 0;
    return x;
  };
  return [...items].sort((a, b) => h(a.decisionKey) - h(b.decisionKey)).slice(0, Math.min(n, items.length));
}
