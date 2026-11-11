import { SAMPLE_AS_OF, type RawCartRow } from "./sample-carts";

/**
 * A deterministic, larger export (~150 carts, ~120 fans, 3 matches x 4 sections) for exercising the review
 * queue at volume. Same shape and rough edges as the real sample (duplicate carts, guest checkouts, unknowns),
 * but internally consistent so it passes the export checks: one sell-through value per match + section.
 * Relative times are anchored at SAMPLE_AS_OF, like the sample.
 */
export const SYNTHETIC_EXPORTED_AT = SAMPLE_AS_OF;

const MATCHES = [
  { label: "Next home match (in 4 days)", sold: { "Lower Bowl": 88, "Upper Deck": 63, Club: 97, Sideline: 74 } },
  { label: "Home match (in 11 days)", sold: { "Lower Bowl": 71, "Upper Deck": 48, Club: 90, Sideline: 58 } },
  { label: "Home match (in 18 days)", sold: { "Lower Bowl": 52, "Upper Deck": 41, Club: 80, Sideline: 45 } },
] as const;
const PRICE: Record<string, number> = { "Lower Bowl": 48, "Upper Deck": 35, Club: 90, Sideline: 42 };

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export function syntheticExport(seed = 7, fanCount = 120): { carts: RawCartRow[]; accounts: { fanId: string; email: string }[] } {
  const r = rng(seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const carts: RawCartRow[] = [];
  const accounts: { fanId: string; email: string }[] = [];
  let n = 0;

  for (let i = 0; i < fanCount; i++) {
    const fanId = `F-${2000 + i}`;
    const email = `fan${2000 + i}@example.com`;
    accounts.push({ fanId, email });
    const seasonPass = r() < 0.08;
    const lifetime = seasonPass ? 20 + Math.floor(r() * 40) : pick([0, 0, 1, 2, 3, 5, 8, 14, 22]);
    const lastPurchase = lifetime === 0 ? "Never" : `${pick([5, 9, 21, 45, 90, 150, 200, 300])} days ago`;
    const shop = r() < 0.05 ? "Unknown" : `$${pick([0, 0, 35, 60, 120, 240, 410])}`;
    const emailOptIn = r() < 0.8 ? "Yes" : "No";
    const pushOptIn = r() < 0.55 ? "Yes" : "No";
    const match = pick(MATCHES);
    const section = seasonPass ? pick(["Club", "Lower Bowl"] as const) : pick(["Lower Bowl", "Upper Deck", "Club", "Sideline"] as const);
    const seats = seasonPass ? 2 + Math.floor(r() * 5) : 1 + Math.floor(r() * 4);
    const base = {
      fanId,
      team: "Seawolves",
      match: match.label,
      seats: String(seats),
      section,
      sectionSoldPct: `${match.sold[section]}%`,
      cartValue: `$${seats * PRICE[section]}`,
      lifetimeTickets: String(lifetime),
      lastPurchase,
      shopSpend12mo: shop,
      seasonPass: seasonPass ? "Yes" : "No",
      emailOptIn,
      pushOptIn,
    };
    const abandonedH = 1 + Math.floor(r() * 70);
    carts.push({ ...base, cartId: `S-${++n}`, source: pick(["Web", "App"]), abandoned: `${abandonedH} hrs ago` });
    // Some fans try twice (web then app), like F-204 in the sample.
    if (r() < 0.15) carts.push({ ...base, cartId: `S-${++n}`, source: "App", abandoned: `${Math.max(1, abandonedH - 1)} hrs ago` });
    // Some fans also have a guest checkout with the same email, like F-511.
    if (r() < 0.06) {
      carts.push({
        ...base,
        cartId: `S-${++n}`,
        fanId: "Guest (no Fan ID)",
        source: "Web",
        abandoned: `${1 + Math.floor(r() * 10)} hrs ago`,
        lifetimeTickets: "Unknown",
        lastPurchase: "Unknown",
        shopSpend12mo: "Unknown",
        checkoutEmail: email,
      });
    }
  }
  return { carts, accounts };
}
