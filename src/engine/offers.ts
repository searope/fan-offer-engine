import type { CostLine, Offer } from "./types";

export const dollars = (c: number) => `$${(c / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/**
 * The offer catalog's cost model: each offer type says what it gives away, as typed lines.
 * Adding an offer type (seat upgrade, match pass, ...) means adding a case here. The card, metrics and
 * guardrails read lines generically, and lines of different kinds are never summed together.
 */
export function costsOf(offer: Offer, cartValueCents: number): CostLine[] {
  switch (offer.type) {
    case "reminder":
      return [];
    case "promo_code": {
      const amount = Math.round((cartValueCents * offer.percentOff) / 100);
      return [{ kind: "ticket_discount", basis: "exact", amountCents: amount, label: `Ticket discount ${dollars(amount)} (${offer.percentOff}% of cart)` }];
    }
    case "merch_addon":
      return [
        {
          kind: "merch_voucher",
          basis: "max",
          amountCents: offer.maxValueCents,
          label: `Merch voucher up to ${dollars(offer.maxValueCents)} (${offer.percentOff}% off the shop, only if redeemed)`,
        },
      ];
    case "perk":
      return [{ kind: "perk", basis: "non_monetary", amountCents: null, label: `Perk: ${offer.label}` }];
  }
}

/** Sum of one kind of cost. Deliberately takes a kind: there is no "total of everything". */
export function costTotal(lines: CostLine[], kind: CostLine["kind"]): number {
  return lines.filter((l) => l.kind === kind).reduce((s, l) => s + (l.amountCents ?? 0), 0);
}
