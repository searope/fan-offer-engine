import type { Channel, Offer, OfferFacts } from "../types";
import { PROMO_PLACEHOLDER, voucherCapText, type MessageCopy } from "./lint";

/** Deterministic fallback copy. Always passes lintCopy (tested). Used when the model is off, fails, or is rejected. */
export function templateCopy(offer: Offer, channel: Channel, f: OfferFacts): MessageCopy {
  const when = f.daysToKickoff === 0 ? "today" : f.daysToKickoff === 1 ? "tomorrow" : `in ${f.daysToKickoff} days`;
  const seats = `${f.seats} seat${f.seats === 1 ? "" : "s"}`;
  if (channel === "sales_task") {
    const perk = offer.type === "perk" ? offer.label : "a personal follow-up";
    return {
      subject: `Call: ${seats} in ${f.section}, match ${when}`,
      body: [
        `Season-pass holder started a ${seats} order in ${f.section} for the match ${when} and didn't finish.`,
        `${f.section} is ${f.sectionSoldPct}% sold, so do not discount.`,
        `Offer: ${perk}, as a thank-you for bringing a group.`,
        `Ask whether anything blocked checkout (seat choice, payment, guest details) and offer to complete it by phone.`,
      ].join("\n"),
    };
  }
  const push = channel === "push";
  switch (offer.type) {
    case "promo_code":
      return push
        ? { subject: `${offer.percentOff}% off your seats`, body: `Your ${seats} for the match ${when} are waiting. Use ${PROMO_PLACEHOLDER} for ${offer.percentOff}% off. One use only.` }
        : {
            subject: `${offer.percentOff}% off to finish your ${f.teamName} order`,
            body: `You picked out ${seats} in the ${f.section} for our match ${when}. Here's ${offer.percentOff}% off to finish your order: ${PROMO_PLACEHOLDER} (single use).\n\nSee you at the match.`,
          };
    case "merch_addon": {
      const cap = voucherCapText(offer.maxValueCents);
      return push
        ? { subject: "Your seat + a match-day bonus", body: `Finish your ticket for the match ${when} and get ${offer.percentOff}% off in the team shop, up to ${cap}, with ${PROMO_PLACEHOLDER}.` }
        : {
            subject: "A match-day bonus when you finish your order",
            body: `Your ${seats} for the match ${when} is still in your cart. Complete it and get ${offer.percentOff}% off in the team shop on match day, up to ${cap}, with ${PROMO_PLACEHOLDER}.`,
          };
    }
    case "perk":
    case "reminder":
      return push
        ? { subject: "Your seats are still in your cart", body: `${seats} in the ${f.section} for the match ${when}. Tap to finish your order.` }
        : {
            subject: `You left your ${f.teamName} seats behind`,
            body: `You picked out ${seats} in the ${f.section} for our match ${when}. They're still in your cart. Finish your order any time before kickoff.\n\nSee you at the match.`,
          };
  }
}
