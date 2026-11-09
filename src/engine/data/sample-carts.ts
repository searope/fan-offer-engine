/**
 * The stale-cart sample from the brief, kept exactly as exported (strings and all).
 * The engine never reads these strings directly: normalize.ts turns them into typed
 * records and records a DataQualityIssue for anything it cannot trust.
 */
export interface RawCartRow {
  cartId: string;
  fanId: string; // "F-204" | "Guest (no Fan ID)"
  team: string;
  source: string; // "Web" | "App"
  match: string; // relative description, e.g. "Next home match (in 4 days)"
  seats: string;
  section: string;
  sectionSoldPct: string; // "88%"
  cartValue: string; // "$96"
  abandoned: string; // "3 hrs ago"
  lifetimeTickets: string; // "14" | "Unknown"
  lastPurchase: string; // "21 days ago" | "Never" | "Unknown"
  shopSpend12mo: string; // "$120" | "Not synced" | "Unknown"
  seasonPass: string; // "Yes" | "No"
  emailOptIn: string;
  pushOptIn: string;
  /** Contact email on the cart. Present for guest checkouts; account carts resolve it from the fan record. */
  checkoutEmail?: string;
}

/** The moment the sample export was taken. All "x hrs ago" / "in n days" values are relative to this. */
export const SAMPLE_AS_OF = "2026-11-09T12:00:00-08:00";

export const SAMPLE_CARTS: RawCartRow[] = [
  { cartId: "C-1001", fanId: "F-204", team: "Seawolves", source: "Web", match: "Next home match (in 4 days)", seats: "2", section: "Lower Bowl", sectionSoldPct: "88%", cartValue: "$96", abandoned: "3 hrs ago", lifetimeTickets: "14", lastPurchase: "21 days ago", shopSpend12mo: "$120", seasonPass: "No", emailOptIn: "Yes", pushOptIn: "Yes" },
  { cartId: "C-1002", fanId: "F-511", team: "Seawolves", source: "Web", match: "Home match (in 18 days)", seats: "4", section: "Upper Deck", sectionSoldPct: "41%", cartValue: "$140", abandoned: "26 hrs ago", lifetimeTickets: "0", lastPurchase: "Never", shopSpend12mo: "$0", seasonPass: "No", emailOptIn: "Yes", pushOptIn: "No" },
  { cartId: "C-1003", fanId: "F-092", team: "Seawolves", source: "App", match: "Next home match (in 4 days)", seats: "1", section: "Lower Bowl", sectionSoldPct: "88%", cartValue: "$58", abandoned: "70 hrs ago", lifetimeTickets: "3", lastPurchase: "180 days ago", shopSpend12mo: "$35", seasonPass: "No", emailOptIn: "No", pushOptIn: "Yes" },
  { cartId: "C-1004", fanId: "F-333", team: "Seawolves", source: "Web", match: "Next home match (in 4 days)", seats: "6", section: "Club", sectionSoldPct: "97%", cartValue: "$540", abandoned: "1 hr ago", lifetimeTickets: "40", lastPurchase: "9 days ago", shopSpend12mo: "$410", seasonPass: "Yes", emailOptIn: "Yes", pushOptIn: "Yes" },
  { cartId: "C-1005", fanId: "F-777", team: "Seawolves", source: "Web", match: "Home match (played 2 days ago)", seats: "2", section: "Upper Deck", sectionSoldPct: "63%", cartValue: "$70", abandoned: "96 hrs ago", lifetimeTickets: "1", lastPurchase: "300 days ago", shopSpend12mo: "$0", seasonPass: "No", emailOptIn: "Yes", pushOptIn: "No" },
  { cartId: "C-1006", fanId: "F-204", team: "Seawolves", source: "App", match: "Next home match (in 4 days)", seats: "2", section: "Lower Bowl", sectionSoldPct: "88%", cartValue: "$96", abandoned: "2 hrs ago", lifetimeTickets: "14", lastPurchase: "21 days ago", shopSpend12mo: "$120", seasonPass: "No", emailOptIn: "Yes", pushOptIn: "Yes" },
  { cartId: "C-1007", fanId: "F-618", team: "League team (onboarding)", source: "Web", match: "Their home match (in 9 days)", seats: "3", section: "Sideline", sectionSoldPct: "55%", cartValue: "$105", abandoned: "30 hrs ago", lifetimeTickets: "2", lastPurchase: "60 days ago", shopSpend12mo: "Not synced", seasonPass: "No", emailOptIn: "Yes", pushOptIn: "No" },
  // Data note from the brief: this guest checkout's email matches the account for F-511.
  { cartId: "C-1008", fanId: "Guest (no Fan ID)", team: "Seawolves", source: "Web", match: "Home match (in 18 days)", seats: "4", section: "Upper Deck", sectionSoldPct: "41%", cartValue: "$140", abandoned: "5 hrs ago", lifetimeTickets: "Unknown", lastPurchase: "Unknown", shopSpend12mo: "Unknown", seasonPass: "No", emailOptIn: "Yes", pushOptIn: "No", checkoutEmail: "fan511@example.com" },
];

/** Fan account contact records (stand-in for the ticketing platform's account table). */
export const SAMPLE_FAN_ACCOUNTS: { fanId: string; email: string }[] = [
  { fanId: "F-204", email: "fan204@example.com" },
  { fanId: "F-511", email: "fan511@example.com" },
  { fanId: "F-092", email: "fan092@example.com" },
  { fanId: "F-333", email: "fan333@example.com" },
  { fanId: "F-777", email: "fan777@example.com" },
  { fanId: "F-618", email: "fan618@example.com" },
];
