import { DAY_MS, HOUR_MS, normalizeCart } from "./normalize";
import { HOLDOUT_EXPERIMENT, POLICY } from "./policy";
import { buildReason } from "./reasons";
import { costsOf } from "./offers";
import type {
  Channel,
  ContactRecord,
  DataQualityIssue,
  Decision,
  EngineInput,
  EngineRun,
  NormalizedCart,
  Offer,
  OfferFacts,
  ReasonCode,
  TenantConfig,
} from "./types";

const TRIGGER = "cart_winback" as const;

interface Item {
  cart: NormalizedCart;
  viaEmail: boolean;
}

/**
 * Trigger #1: cart win-back. Pure and synchronous. No clock, no I/O, no randomness.
 * Every input cart ends up in exactly one Decision (SPEC §6).
 */
export function decide(input: EngineInput): EngineRun {
  const asOfMs = Date.parse(input.asOf);
  const exportedMs = Date.parse(input.exportedAt ?? input.asOf);
  if (Number.isNaN(asOfMs) || Number.isNaN(exportedMs)) throw new Error(`decide: invalid asOf/exportedAt`);

  const dataIssues: DataQualityIssue[] = [];
  const decisions: Decision[] = [];
  const tenantsByTeam = new Map(input.tenants.map((t) => [t.teamName, t]));

  const emailIndex = new Map<string, Set<string>>();
  for (const a of input.fanAccounts) {
    const e = a.email.trim().toLowerCase();
    if (!emailIndex.has(e)) emailIndex.set(e, new Set());
    emailIndex.get(e)!.add(a.fanId);
  }

  const groups = new Map<string, { tenant: TenantConfig; fanId: string; items: Item[] }>();
  const rows = [...input.carts].sort((a, b) => a.cartId.localeCompare(b.cartId));

  for (const raw of rows) {
    const { cart, issues } = normalizeCart(raw, exportedMs);
    dataIssues.push(...issues);
    const single = (codes: ReasonCode[], extra: Partial<Decision> = {}): Decision => ({
      key: `cart:${raw.cartId}`,
      tenantId: null,
      fanId: null,
      matchId: cart?.matchId ?? "unknown",
      cartIds: [raw.cartId],
      outcome: "hold",
      reasonCodes: codes,
      reason: buildReason(codes, { teamName: raw.team }),
      ...extra,
    });

    if (!cart) {
      decisions.push(single(["BAD_DATA"]));
      continue;
    }
    const tenant = tenantsByTeam.get(cart.teamName);
    if (!tenant) {
      decisions.push(single(["UNKNOWN_TENANT"]));
      continue;
    }

    // Identity: exact (case-insensitive) email match to exactly one account, or hold. Never fuzzy.
    let fanId = cart.fanId;
    let viaEmail = false;
    if (!fanId) {
      const matches = cart.checkoutEmail ? emailIndex.get(cart.checkoutEmail) : undefined;
      if (matches && matches.size === 1) {
        fanId = [...matches][0];
        viaEmail = true;
      } else {
        decisions.push(single(["UNRESOLVED_IDENTITY"], { tenantId: tenant.tenantId, key: `${tenant.tenantId}:cart:${raw.cartId}` }));
        continue;
      }
    }

    const key = `${tenant.tenantId}:${fanId}:${cart.matchId}`;
    if (!groups.has(key)) groups.set(key, { tenant, fanId, items: [] });
    groups.get(key)!.items.push({ cart, viaEmail });
  }

  const groupDecisions = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, g]) => decideGroup(key, g.tenant, g.fanId, g.items, input.contactHistory, asOfMs));

  // One proposal per fan per run: keep the most time-sensitive (soonest kickoff, then higher value).
  const byFan = new Map<string, Decision[]>();
  for (const d of groupDecisions) {
    if (d.outcome !== "propose") continue;
    const k = `${d.tenantId}:${d.fanId}`;
    if (!byFan.has(k)) byFan.set(k, []);
    byFan.get(k)!.push(d);
  }
  for (const ds of byFan.values()) {
    if (ds.length < 2) continue;
    ds.sort(
      (a, b) =>
        a.proposal!.facts.kickoffAt.localeCompare(b.proposal!.facts.kickoffAt) ||
        b.proposal!.cartValueCents - a.proposal!.cartValueCents ||
        a.key.localeCompare(b.key),
    );
    for (const loser of ds.slice(1)) {
      loser.outcome = "suppress";
      loser.reasonCodes = ["OTHER_OFFER_THIS_RUN", ...loser.reasonCodes];
      loser.reason = buildReason(loser.reasonCodes, {});
      delete loser.proposal;
    }
  }

  decisions.push(...groupDecisions);
  decisions.sort((a, b) => [...a.cartIds].sort()[0].localeCompare([...b.cartIds].sort()[0]));
  return { asOf: input.asOf, trigger: TRIGGER, decisions, dataIssues };
}

function decideGroup(
  key: string,
  tenant: TenantConfig,
  fanId: string,
  items: Item[],
  history: ContactRecord[],
  asOfMs: number,
): Decision {
  // Latest intent first. Profile fields come from account carts (guest rows say "Unknown").
  const carts = items.map((i) => i.cart).sort((a, b) => b.abandonedAt.localeCompare(a.abandonedAt));
  const latest = carts[0];
  const accountCarts = carts.filter((c) => c.fanId !== null);
  const profileSrc = accountCarts.length ? accountCarts : carts;
  const firstKnown = <T,>(f: (c: NormalizedCart) => T | null) => profileSrc.map(f).find((v) => v !== null) ?? null;

  const lifetimeTickets = firstKnown((c) => c.lifetimeTickets);
  const lpCart = profileSrc.find((c) => c.lastPurchaseKnown);
  const lastPurchaseKnown = !!lpCart;
  const lastPurchaseAt = lpCart?.lastPurchaseAt ?? null;
  const seasonPass = profileSrc.some((c) => c.seasonPass);
  // Consent: most conservative across all carts (SPEC §6.3).
  const emailOk = carts.every((c) => c.emailOptIn);
  const pushOk = carts.every((c) => c.pushOptIn);

  const kickoffMs = Date.parse(latest.kickoffAt);
  const daysSinceLastPurchase = lastPurchaseAt ? Math.round((asOfMs - Date.parse(lastPurchaseAt)) / DAY_MS) : null;
  const facts: OfferFacts = {
    teamName: tenant.teamName,
    section: latest.section,
    seats: latest.seats,
    sectionSoldPct: latest.sectionSoldPct,
    daysToKickoff: Math.max(0, Math.round((kickoffMs - asOfMs) / DAY_MS)),
    kickoffAt: latest.kickoffAt,
    lifetimeTickets,
    daysSinceLastPurchase,
    latestSource: latest.source,
  };

  const codes: ReasonCode[] = [];
  if (carts.length > 1) codes.push("MERGED_DUPLICATE_CARTS");
  if (items.some((i) => i.viaEmail)) codes.push("GUEST_MATCHED_BY_EMAIL");

  const base = {
    key,
    tenantId: tenant.tenantId,
    fanId,
    matchId: latest.matchId,
    cartIds: carts.map((c) => c.cartId).sort(),
  };
  const stop = (outcome: "hold" | "suppress", gate: ReasonCode): Decision => {
    const reasonCodes = [gate, ...codes];
    return { ...base, outcome, reasonCodes, reason: buildReason(reasonCodes, { ...facts, cartCount: carts.length }) };
  };

  // ---- Gates (SPEC §3), first match wins ----
  if (!tenant.offersEnabled) return stop("hold", "TENANT_NOT_ENABLED");
  if (kickoffMs <= asOfMs) return stop("suppress", "MATCH_ALREADY_PLAYED");
  if (kickoffMs - asOfMs < POLICY.minHoursBeforeKickoff * HOUR_MS) return stop("suppress", "MATCH_TOO_SOON");
  if (!emailOk && !pushOk && !seasonPass) return stop("suppress", "NO_CONSENTED_CHANNEL");

  const mine = history.filter((h) => h.tenantId === tenant.tenantId && h.fanId === fanId && Date.parse(h.sentAt) <= asOfMs);
  const otherRecent = mine.filter(
    (h) => h.matchId !== latest.matchId && asOfMs - Date.parse(h.sentAt) < POLICY.otherMatchCooldownDays * DAY_MS,
  );
  if (otherRecent.length) return stop("suppress", "RECENTLY_CONTACTED");
  const thisMatch = mine.filter((h) => h.matchId === latest.matchId).sort((a, b) => b.sentAt.localeCompare(a.sentAt));

  // ---- Segment and inventory signals ----
  const isNew = lifetimeTickets === 0 || (lastPurchaseKnown && lastPurchaseAt === null);
  const isLapsed = !isNew && daysSinceLastPurchase !== null && daysSinceLastPurchase > POLICY.lapsedAfterDays;
  if (seasonPass) codes.push("SEASON_PASS_HOLDER");
  else if (isNew) codes.push("NEW_FAN");
  else if (isLapsed) codes.push("LAPSED_FAN");
  else if (lifetimeTickets !== null) codes.push("REGULAR_FAN");

  const high = latest.sectionSoldPct >= POLICY.highSellThroughPct;
  const low = latest.sectionSoldPct < POLICY.lowSellThroughPct;
  if (high) codes.push("HIGH_SELL_THROUGH");
  else if (low) codes.push("LOW_SELL_THROUGH");

  // ---- Offer (SPEC §4, §4a) ----
  let offer: Offer;
  let touchNumber: 1 | 2 = 1;
  if (thisMatch.length >= POLICY.maxTouchesPerMatch) return stop("suppress", "ALREADY_CONTACTED_FOR_MATCH");
  if (thisMatch.length === 1) {
    const prev = thisMatch[0];
    const canEscalate =
      prev.offerType === "reminder" &&
      asOfMs - Date.parse(prev.sentAt) >= POLICY.escalateAfterHours * HOUR_MS &&
      low &&
      kickoffMs - asOfMs >= POLICY.escalateMinHoursBeforeKickoff * HOUR_MS &&
      !seasonPass;
    if (!canEscalate) return stop("suppress", "ALREADY_CONTACTED_FOR_MATCH");
    offer = { type: "promo_code", percentOff: tenant.defaultPromoPct, singleUse: true };
    touchNumber = 2;
    codes.push("ESCALATED_SECOND_TOUCH");
  } else if (seasonPass && tenant.perks.length) {
    offer = { type: "perk", perkId: tenant.perks[0].perkId, label: tenant.perks[0].label };
  } else if (high && isLapsed) {
    offer = { type: "merch_addon", percentOff: tenant.merchAddonPct, maxValueCents: tenant.merchAddonMaxCents, singleUse: true };
  } else {
    offer = { type: "reminder" };
  }

  // ---- Channel ----
  let channel: Channel;
  if (offer.type === "perk") {
    channel = "sales_task";
  } else {
    const preferred: Channel = latest.source === "app" ? "push" : "email";
    const ok = (c: Channel) => (c === "email" ? emailOk : pushOk);
    if (ok(preferred)) {
      channel = preferred;
      codes.push("CHANNEL_FROM_RECENT_SOURCE");
    } else {
      const other: Channel = preferred === "push" ? "email" : "push";
      if (!ok(other)) return stop("suppress", "NO_CONSENTED_CHANNEL"); // season-pass holder with no perks configured and no consent
      channel = other;
      codes.push("CHANNEL_FALLBACK_CONSENT");
    }
  }

  // ---- Holdout (SPEC §4c): first touches only, never the salesperson's perk calls ----
  const heldOut = touchNumber === 1 && offer.type !== "perk" && holdoutBucket(tenant.tenantId, fanId, latest.matchId) < tenant.holdoutPct;
  const reason = buildReason(codes, { ...facts, cartCount: carts.length }, channel);
  if (heldOut) codes.push("HOLDOUT");

  return {
    ...base,
    outcome: heldOut ? "holdout" : "propose",
    reasonCodes: codes,
    reason: heldOut
      ? `Held out for measurement: ${tenant.holdoutPct}% of fans are picked at random and not contacted, so we can tell whether offers cause purchases. This fan would have received the offer shown. ${reason}`
      : reason,
    proposal: {
      offer,
      channel,
      cartValueCents: latest.cartValueCents,
      costs: costsOf(offer, latest.cartValueCents),
      expiresAt: new Date(kickoffMs - POLICY.minHoursBeforeKickoff * HOUR_MS).toISOString(),
      touchNumber,
      idempotencyKey: `${tenant.tenantId}:${TRIGGER}:${fanId}:${latest.matchId}:t${touchNumber}`,
      facts,
    },
  };
}

/** 0..99, from a 32-bit FNV-1a hash of experiment x tenant x fan x match. Pure and stable across runs. */
export function holdoutBucket(tenantId: string, fanId: string, matchId: string): number {
  let h = 0x811c9dc5;
  for (const ch of `${HOLDOUT_EXPERIMENT}:${tenantId}:${fanId}:${matchId}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 100;
}
