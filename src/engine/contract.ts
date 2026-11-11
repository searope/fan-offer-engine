import { HOUR_MS, normalizeCart } from "./normalize";
import type { RawCartRow } from "./types";

/**
 * The single assumption the whole offer table depends on: the ticketing export's sell-through and
 * consent fields can be trusted. Sell-through decides whether a discount earns or gives away revenue;
 * consent decides whether we may contact the fan at all. checkExport() tests that assumption on every
 * run, before decide() sees the data. If it fails, the run pauses and nothing is proposed.
 */
export const CONTRACT = {
  /** Older than this, sell-through and consent may have moved on. */
  maxExportAgeHours: 6,
  /** One match+section must report one sell-through number (rounding aside). */
  maxSellThroughSpreadPts: 2,
  /** Sold seats rarely un-sell; refunds move a few points, not ten. */
  maxSellThroughDropPts: 10,
  /** Below this many rows a share swing is noise, so it isn't judged. */
  minRowsForShareCheck: 20,
  maxConsentShareShiftPts: 20,
  /** Export says opted in, fan record says opted out: some churn is normal, a lot means a stale export. */
  minFansForDisagreement: 5,
  maxConsentDisagreementShare: 0.2,
  /** Rows whose match, seats, price or sell-through can't be read. */
  maxUnreadableShare: 0.25,
} as const;

export interface ExportSnapshot {
  exportedAt: string;
  rowCount: number;
  emailOptInShare: number;
  pushOptInShare: number;
  /** `${matchId}|${section}` -> sell-through %. */
  sellThrough: Record<string, number>;
}

export type ContractCode =
  | "STALE_EXPORT"
  | "SELL_THROUGH_INCONSISTENT"
  | "SELL_THROUGH_DROP"
  | "CONSENT_SHARE_SHIFT"
  | "CONSENT_DISAGREES_WITH_FAN_RECORD"
  | "FIELD_UNREADABLE";

export interface ContractProblem {
  code: ContractCode;
  message: string;
}

export interface ContractResult {
  ok: boolean;
  problems: ContractProblem[];
  snapshot: ExportSnapshot;
}

export interface ContractInput {
  carts: RawCartRow[];
  exportedAt: string;
  asOf: string;
  /** Snapshot of the last export a run accepted; null on the first run. */
  previous: ExportSnapshot | null;
  /** Current consent from the fan record (source of truth). */
  fanRecords: { fanId: string; email: boolean; push: boolean }[];
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

export function checkExport(input: ContractInput): ContractResult {
  const problems: ContractProblem[] = [];
  const exportedMs = Date.parse(input.exportedAt);
  const asOfMs = Date.parse(input.asOf);

  const ageH = (asOfMs - exportedMs) / HOUR_MS;
  if (ageH > CONTRACT.maxExportAgeHours) {
    problems.push({ code: "STALE_EXPORT", message: `The cart export is ${Math.round(ageH)} hours old (limit ${CONTRACT.maxExportAgeHours}). Sell-through and opt-ins may have changed since.` });
  } else if (ageH < -0.1) {
    problems.push({ code: "STALE_EXPORT", message: "The cart export is stamped in the future. The export clock or job is wrong." });
  }

  // Sell-through per match+section, and unreadable rows.
  const byKey = new Map<string, number[]>();
  let unreadable = 0;
  for (const raw of input.carts) {
    const { cart } = normalizeCart(raw, exportedMs);
    if (!cart) {
      unreadable++;
      continue;
    }
    const k = `${cart.matchId}|${cart.section}`;
    byKey.set(k, [...(byKey.get(k) ?? []), cart.sectionSoldPct]);
  }
  const rowCount = input.carts.length;
  if (rowCount && unreadable / rowCount > CONTRACT.maxUnreadableShare) {
    problems.push({ code: "FIELD_UNREADABLE", message: `${unreadable} of ${rowCount} carts have an unreadable match, seat count, price or sell-through (limit ${pct(CONTRACT.maxUnreadableShare)}).` });
  }

  const sellThrough: Record<string, number> = {};
  for (const [k, vals] of byKey) {
    const spread = Math.max(...vals) - Math.min(...vals);
    if (spread > CONTRACT.maxSellThroughSpreadPts) {
      problems.push({ code: "SELL_THROUGH_INCONSISTENT", message: `${k.split("|")[1]} for match ${k.split("|")[0]} is reported as both ${Math.min(...vals)}% and ${Math.max(...vals)}% sold in the same export.` });
    }
    sellThrough[k] = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    const prev = input.previous?.sellThrough[k];
    if (prev !== undefined && prev - sellThrough[k] > CONTRACT.maxSellThroughDropPts) {
      problems.push({ code: "SELL_THROUGH_DROP", message: `${k.split("|")[1]} for match ${k.split("|")[0]} fell from ${prev}% to ${sellThrough[k]}% sold since the last accepted export. Seats rarely un-sell; the feed is likely wrong.` });
    }
  }

  // Opted-in shares, compared with the last accepted export when both are big enough to mean something.
  const yes = (v: string) => /^\s*yes\s*$/i.test(v);
  const emailShare = rowCount ? input.carts.filter((c) => yes(c.emailOptIn)).length / rowCount : 0;
  const pushShare = rowCount ? input.carts.filter((c) => yes(c.pushOptIn)).length / rowCount : 0;
  const p = input.previous;
  if (p && rowCount >= CONTRACT.minRowsForShareCheck && p.rowCount >= CONTRACT.minRowsForShareCheck) {
    for (const [name, now, before] of [["email", emailShare, p.emailOptInShare], ["push", pushShare, p.pushOptInShare]] as const) {
      if (Math.abs(now - before) * 100 > CONTRACT.maxConsentShareShiftPts) {
        problems.push({ code: "CONSENT_SHARE_SHIFT", message: `The share of carts opted in to ${name} moved from ${pct(before)} to ${pct(now)} since the last accepted export. Check the consent column before sending anything.` });
      }
    }
  }

  // Export vs fan record: "Yes" in the export where the record says "No".
  const records = new Map(input.fanRecords.map((f) => [f.fanId, f]));
  const fans = new Map<string, { email: boolean; push: boolean }>();
  for (const c of input.carts) {
    const id = c.fanId.trim();
    if (!records.has(id)) continue;
    const prev = fans.get(id) ?? { email: true, push: true };
    fans.set(id, { email: prev.email && yes(c.emailOptIn), push: prev.push && yes(c.pushOptIn) });
  }
  if (fans.size >= CONTRACT.minFansForDisagreement) {
    const disagree = [...fans].filter(([id, e]) => (e.email && !records.get(id)!.email) || (e.push && !records.get(id)!.push)).length;
    if (disagree / fans.size > CONTRACT.maxConsentDisagreementShare) {
      problems.push({ code: "CONSENT_DISAGREES_WITH_FAN_RECORD", message: `${disagree} of ${fans.size} fans are opted in according to the export but opted out in their fan record. The export's consent looks stale.` });
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    snapshot: { exportedAt: input.exportedAt, rowCount, emailOptInShare: emailShare, pushOptInShare: pushShare, sellThrough },
  };
}
