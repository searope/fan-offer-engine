/**
 * Holdout assignment key. Hashing fan x match with this name makes assignment random but repeatable;
 * renaming it (v2, ...) re-randomizes everyone, e.g. when starting a new measurement period.
 */
export const HOLDOUT_EXPERIMENT = "cart-winback-holdout-v1";

/**
 * Every threshold the engine uses, in one place, so a marketer's question ("why 75%?") has one answer
 * and changing it is a one-line, reviewed diff. See SPEC.md §3–4a.
 */
export const POLICY = {
  /** Section sell-through at or above this: seats sell at full price, no ticket discount. */
  highSellThroughPct: 75,
  /** Below this, a section is "soft": a discount can earn revenue (second touch only). */
  lowSellThroughPct: 60,
  /** Last purchase older than this = lapsed fan. */
  lapsedAfterDays: 120,
  /** Don't send anything closer to kickoff than this. Also the proposal expiry buffer. */
  minHoursBeforeKickoff: 6,
  /** Cross-match frequency cap. */
  otherMatchCooldownDays: 7,
  /** Escalation (§4a): wait this long after a reminder before a promo. */
  escalateAfterHours: 72,
  /** Escalation: kickoff must be at least this far away. */
  escalateMinHoursBeforeKickoff: 48,
  /** Max touches per fan per match. */
  maxTouchesPerMatch: 2,
} as const;
