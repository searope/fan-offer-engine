import type { DataQualityIssue, NormalizedCart, RawCartRow } from "./types";

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

const UNIT_MS: Record<string, number> = { hr: HOUR_MS, hrs: HOUR_MS, hour: HOUR_MS, hours: HOUR_MS, day: DAY_MS, days: DAY_MS };

/** "3 hrs ago" | "21 days ago" -> ms in the past, or null. */
function parseAgo(s: string): number | null {
  const m = /^\s*(\d+)\s*(hrs?|hours?|days?)\s+ago\s*$/i.exec(s);
  return m ? Number(m[1]) * UNIT_MS[m[2].toLowerCase()] : null;
}

/** "Next home match (in 4 days)" | "Home match (played 2 days ago)" -> signed offset from asOf. */
function parseMatchOffset(s: string): number | null {
  const ahead = /\(in\s+(\d+)\s*(hrs?|hours?|days?)\)/i.exec(s);
  if (ahead) return Number(ahead[1]) * UNIT_MS[ahead[2].toLowerCase()];
  const past = /\(played\s+(\d+)\s*(hrs?|hours?|days?)\s+ago\)/i.exec(s);
  if (past) return -Number(past[1]) * UNIT_MS[past[2].toLowerCase()];
  return null;
}

function parseMoneyCents(s: string): number | null {
  const m = /^\s*\$\s*([\d,]+(?:\.\d{1,2})?)\s*$/.exec(s);
  return m ? Math.round(Number(m[1].replace(/,/g, "")) * 100) : null;
}

function parsePct(s: string): number | null {
  const m = /^\s*(\d{1,3}(?:\.\d+)?)\s*%\s*$/.exec(s);
  const n = m ? Number(m[1]) : NaN;
  return n >= 0 && n <= 100 ? n : null;
}

function parseIntStrict(s: string): number | null {
  return /^\s*\d+\s*$/.test(s) ? Number(s) : null;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

/**
 * Turn one exported row into a typed cart. Every value we can't read becomes `null` plus a
 * DataQualityIssue. Opt-ins that aren't a clear "Yes" are treated as NOT consented (fail closed).
 * Returns cart = null when a field the decision depends on is unreadable; the caller holds that cart.
 *
 * Note: the sample export uses relative times ("3 hrs ago"). In production, ticketing gives us
 * absolute timestamps and a real match id; only this function changes.
 */
export function normalizeCart(raw: RawCartRow, asOfMs: number): { cart: NormalizedCart | null; issues: DataQualityIssue[] } {
  const issues: DataQualityIssue[] = [];
  const flag = (field: keyof RawCartRow, value: string | undefined) => {
    const v = (value ?? "").trim();
    const issue: DataQualityIssue["issue"] = /^unknown$/i.test(v) ? "unknown" : /not synced/i.test(v) ? "not_synced" : "unparseable";
    issues.push({ cartId: raw.cartId, field, raw: v, issue });
  };

  const matchOffset = parseMatchOffset(raw.match);
  if (matchOffset === null) flag("match", raw.match);
  const seats = parseIntStrict(raw.seats);
  if (seats === null) flag("seats", raw.seats);
  const soldPct = parsePct(raw.sectionSoldPct);
  if (soldPct === null) flag("sectionSoldPct", raw.sectionSoldPct);
  const value = parseMoneyCents(raw.cartValue);
  if (value === null) flag("cartValue", raw.cartValue);
  const abandonedAgo = parseAgo(raw.abandoned);
  if (abandonedAgo === null) flag("abandoned", raw.abandoned);

  const lifetimeTickets = parseIntStrict(raw.lifetimeTickets);
  if (lifetimeTickets === null) flag("lifetimeTickets", raw.lifetimeTickets);

  let lastPurchaseAt: string | null = null;
  let lastPurchaseKnown = true;
  if (/^\s*never\s*$/i.test(raw.lastPurchase)) {
    lastPurchaseAt = null;
  } else {
    const ago = parseAgo(raw.lastPurchase);
    if (ago === null) {
      lastPurchaseKnown = false;
      flag("lastPurchase", raw.lastPurchase);
    } else lastPurchaseAt = new Date(asOfMs - ago).toISOString();
  }

  const shop = parseMoneyCents(raw.shopSpend12mo);
  if (shop === null) flag("shopSpend12mo", raw.shopSpend12mo);

  const yesNo = (field: keyof RawCartRow, v: string): boolean => {
    if (/^\s*yes\s*$/i.test(v)) return true;
    if (!/^\s*no\s*$/i.test(v)) flag(field, v);
    return false; // anything not a clear "Yes" is "No"
  };
  const seasonPass = yesNo("seasonPass", raw.seasonPass);
  const emailOptIn = yesNo("emailOptIn", raw.emailOptIn);
  const pushOptIn = yesNo("pushOptIn", raw.pushOptIn);

  const source = /^\s*app\s*$/i.test(raw.source) ? "app" : /^\s*web\s*$/i.test(raw.source) ? "web" : null;
  if (source === null) flag("source", raw.source);

  const isGuest = !/^F-\d+$/.test(raw.fanId.trim());

  if (matchOffset === null || seats === null || soldPct === null || value === null || abandonedAgo === null || source === null) {
    return { cart: null, issues };
  }

  const kickoffAt = new Date(asOfMs + matchOffset).toISOString();
  return {
    cart: {
      cartId: raw.cartId,
      fanId: isGuest ? null : raw.fanId.trim(),
      checkoutEmail: raw.checkoutEmail?.trim().toLowerCase() || null,
      teamName: raw.team.trim(),
      source,
      matchId: `${slug(raw.team)}:${kickoffAt.slice(0, 10)}`,
      kickoffAt,
      seats,
      section: raw.section.trim(),
      sectionSoldPct: soldPct,
      cartValueCents: value,
      abandonedAt: new Date(asOfMs - abandonedAgo).toISOString(),
      lifetimeTickets,
      lastPurchaseAt,
      lastPurchaseKnown,
      shopSpend12moCents: shop,
      seasonPass,
      emailOptIn,
      pushOptIn,
    },
    issues,
  };
}
