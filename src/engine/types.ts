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
  merchAddonPct: number;
  /** Max value of one merch voucher. Bounds its worst-case cost; enforced by guardrails. */
  merchAddonMaxCents: number;
  /** % of first-touch decisions held out (decided, never sent) to measure whether offers cause purchases. */
  holdoutPct: number;
  /** Non-price perks the salesperson can offer top fans. First entry is the default. */
  perks: { perkId: string; label: string }[];
}

export interface ContactRecord {
  tenantId: string;
  fanId: string;
  matchId: string | null;
  channel: Channel;
  offerType: Offer["type"];
  sentAt: string; // ISO
}

export type Offer =
  | { type: "reminder" }
  | { type: "promo_code"; percentOff: number; singleUse: true }
  | { type: "merch_addon"; percentOff: number; maxValueCents: number; singleUse: true }
  | { type: "perk"; perkId: string; label: string };

export type ReasonCode =
  // gates
  | "BAD_DATA"
  | "OTHER_OFFER_THIS_RUN"
  | "UNKNOWN_TENANT"
  | "TENANT_NOT_ENABLED"
  | "UNRESOLVED_IDENTITY"
  | "MATCH_ALREADY_PLAYED"
  | "MATCH_TOO_SOON"
  | "NO_CONSENTED_CHANNEL"
  | "RECENTLY_CONTACTED"
  | "ALREADY_CONTACTED_FOR_MATCH"
  // signals that shaped a proposal
  | "MERGED_DUPLICATE_CARTS"
  | "GUEST_MATCHED_BY_EMAIL"
  | "SEASON_PASS_HOLDER"
  | "HIGH_SELL_THROUGH"
  | "LOW_SELL_THROUGH"
  | "NEW_FAN"
  | "LAPSED_FAN"
  | "REGULAR_FAN"
  | "ESCALATED_SECOND_TOUCH"
  | "HOLDOUT"
  | "CHANNEL_FROM_RECENT_SOURCE"
  | "CHANNEL_FALLBACK_CONSENT";

export interface Proposal {
  offer: Offer;
  channel: Channel;
  /** Revenue the cart represents; shown to the marketer next to the offer's costs. */
  cartValueCents: number;
  /** What the offer gives away, one typed line per kind of cost (see offers.ts). Never summed across kinds. */
  costs: CostLine[];
  /** Proposal can't be sent after this (kickoff minus a buffer). */
  expiresAt: string;
  /** 1 = first touch for this fan+match, 2 = escalation (SPEC §4a). Max 2. */
  touchNumber: 1 | 2;
  /** Outbox idempotency key: tenant:trigger:fan:match:touch. */
  idempotencyKey: string;
  /** Facts the reason and the copy are built from. The model only ever sees these. */
  facts: OfferFacts;
}

export interface CostLine {
  kind: "ticket_discount" | "merch_voucher" | "perk";
  /** exact = known now; max = worst case (actual depends on what the fan buys); non_monetary = not dollars. */
  basis: "exact" | "max" | "non_monetary";
  amountCents: number | null;
  label: string;
}

export interface OfferFacts {
  teamName: string;
  section: string;
  seats: number;
  sectionSoldPct: number;
  daysToKickoff: number;
  kickoffAt: string;
  lifetimeTickets: number | null;
  daysSinceLastPurchase: number | null; // null = never or unknown
  latestSource: CartSource;
}

export interface Decision {
  /** Stable id for the decision group: tenant:fan:match, or tenant:cart for unresolved carts. */
  key: string;
  tenantId: string | null;
  fanId: string | null;
  matchId: string;
  cartIds: string[];
  /** holdout = decided but deliberately not sent, for measurement (SPEC §4c). */
  outcome: "propose" | "holdout" | "suppress" | "hold";
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
  /** "Now" for every gate and expiry. */
  asOf: string;
  /** When the cart export was taken; relative values ("3 hrs ago") are anchored here. Defaults to asOf. */
  exportedAt?: string;
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
    | "MERCH_OVER_CAP"
    | "CHANNEL_NOT_CONSENTED"
    | "CHANNEL_OFFER_MISMATCH"
    | "TENANT_NOT_ENABLED"
    | "EXPIRED"
    | "ALREADY_CONTACTED";
  message: string;
}
