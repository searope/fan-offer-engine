import type { RawCartRow } from "./data/sample-carts";

export type { RawCartRow };

export type Channel = "email" | "push" | "sales_task";
export type CartSource = "web" | "app";

/** A value we could not read is `null`, never a guessed default. */
export interface NormalizedCart {
  cartId: string;
  fanId: string | null; // null = guest checkout
  checkoutEmail: string | null;
  teamName: string;
  source: CartSource;
  matchId: string;
  kickoffAt: string; // ISO
  seats: number;
  section: string;
  sectionSoldPct: number; // 0..100
  cartValueCents: number;
  abandonedAt: string; // ISO
  lifetimeTickets: number | null;
  lastPurchaseAt: string | null; // null = never or unknown; see lastPurchaseKnown
  lastPurchaseKnown: boolean;
  shopSpend12moCents: number | null;
  seasonPass: boolean;
  emailOptIn: boolean;
  pushOptIn: boolean;
}

export interface DataQualityIssue {
  cartId: string;
  field: keyof RawCartRow;
  raw: string;
  issue: "unknown" | "not_synced" | "unparseable";
}

export interface TenantConfig {
  tenantId: string;
  teamName: string; // as it appears in the cart export
  offersEnabled: boolean;
  /** Hard cap enforced by guardrails. The brief: promo codes are single-use and capped at 15%. */
  maxPromoPct: number;
  defaultPromoPct: number;
}

export interface ContactRecord {
  tenantId: string;
  fanId: string;
  matchId: string | null;
  channel: Channel;
  sentAt: string; // ISO
}

export type Offer =
  | { type: "reminder" }
  | { type: "promo_code"; percentOff: number; singleUse: true }
  | { type: "merch_addon"; percentOff: number; singleUse: true }
  | { type: "seat_upgrade" }
  | { type: "match_pass" }
  | { type: "sales_handoff" };

export type ReasonCode =
  // gates
  | "UNKNOWN_TENANT"
  | "TENANT_NOT_ENABLED"
  | "UNRESOLVED_IDENTITY"
  | "MATCH_ALREADY_PLAYED"
  | "MATCH_TOO_SOON"
  | "NO_CONSENTED_CHANNEL"
  | "RECENTLY_CONTACTED"
  // signals that shaped a proposal
  | "MERGED_DUPLICATE_CARTS"
  | "GUEST_MATCHED_BY_EMAIL"
  | "SEASON_PASS_HOLDER"
  | "HIGH_SELL_THROUGH"
  | "LOW_SELL_THROUGH"
  | "NEW_FAN"
  | "LAPSED_FAN"
  | "REGULAR_FAN"
  | "CHANNEL_FROM_RECENT_SOURCE"
  | "CHANNEL_FALLBACK_CONSENT";

export interface Proposal {
  offer: Offer;
  channel: Channel;
  /** Revenue the cart represents vs. what the offer gives away; shown to the marketer. */
  cartValueCents: number;
  discountCostCents: number;
  /** Proposal can't be sent after this (kickoff minus a buffer). */
  expiresAt: string;
  /** Outbox idempotency key: tenant:trigger:fan:match. */
  idempotencyKey: string;
}

export interface Decision {
  /** Stable id for the decision group: tenant:fan:match, or tenant:cart for unresolved carts. */
  key: string;
  tenantId: string | null;
  fanId: string | null;
  matchId: string;
  cartIds: string[];
  outcome: "propose" | "suppress" | "hold";
  reasonCodes: ReasonCode[];
  /** Plain-English reason for the marketer, generated from reasonCodes (not by a model). */
  reason: string;
  proposal?: Proposal;
}

export interface EngineInput {
  carts: RawCartRow[];
  fanAccounts: { fanId: string; email: string }[];
  contactHistory: ContactRecord[];
  tenants: TenantConfig[];
  asOf: string;
}

export interface EngineRun {
  asOf: string;
  trigger: "cart_winback";
  decisions: Decision[];
  dataIssues: DataQualityIssue[];
}

export interface GuardrailViolation {
  code:
    | "PROMO_OVER_CAP"
    | "PROMO_NOT_SINGLE_USE"
    | "CHANNEL_NOT_CONSENTED"
    | "TENANT_NOT_ENABLED"
    | "EXPIRED"
    | "ALREADY_CONTACTED";
  message: string;
}
