import type { TenantConfig } from "./types";

/**
 * Platform-wide hard cap from the brief. A tenant can configure a lower cap, never a higher one:
 * guardrails use min(tenant.maxPromoPct, PLATFORM_MAX_PROMO_PCT).
 */
export const PLATFORM_MAX_PROMO_PCT = 15;

/**
 * Per-team config. Onboarding a new league team means adding a row here with offersEnabled: false,
 * checking its data in the queue (its carts show as "held"), then flipping the flag. No code change.
 * In production this lives in a tenants table, not in code.
 */
export const DEFAULT_TENANTS: TenantConfig[] = [
  {
    tenantId: "seawolves",
    teamName: "Seawolves",
    offersEnabled: true,
    maxPromoPct: 15,
    defaultPromoPct: 10,
    merchAddonPct: 10,
    merchAddonMaxCents: 1000,
    perks: [{ perkId: "pitchside-access", label: "Pre-match pitch-side access for your group" }],
  },
  {
    tenantId: "league-onboarding",
    teamName: "League team (onboarding)",
    offersEnabled: false, // shop data not synced yet; no offer catalog or brand voice signed off
    maxPromoPct: 15,
    defaultPromoPct: 10,
    merchAddonPct: 10,
    merchAddonMaxCents: 1000,
    perks: [],
  },
];
