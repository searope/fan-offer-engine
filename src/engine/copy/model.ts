import type { Channel, Offer, OfferFacts } from "../types";
import { describeOffer } from "../reasons";
import { LIMITS, MESSAGE_COPY_JSON_SCHEMA, PROMO_PLACEHOLDER } from "./lint";

export interface CopyRequest {
  offer: Offer;
  channel: Channel;
  facts: OfferFacts;
}

/** Anything that can draft copy. The engine depends on this interface, not on a vendor. */
export interface CopyModel {
  readonly name: string;
  draft(req: CopyRequest, signal: AbortSignal): Promise<unknown>;
}

/**
 * Builds the prompt. The model gets the decided offer and non-identifying facts only:
 * no fan id, email, or name. It writes words; it doesn't choose offers, discounts, or recipients.
 */
export function buildPrompt({ offer, channel, facts }: CopyRequest): string {
  const lim = LIMITS[channel];
  const hasCode = offer.type === "promo_code" || offer.type === "merch_addon";
  const kind =
    channel === "email" ? "a short transactional-style email" : channel === "push" ? "an in-app push notification" : "call talking points for the club's salesperson (internal, not sent to the fan)";
  return [
    `You write win-back messages for ${facts.teamName}, a professional rugby club with a small, loyal fan base.`,
    `Write ${kind} for a fan who started buying tickets and didn't finish.`,
    ``,
    `Offer (already decided, do not change it): ${describeOffer(offer)}.`,
    `Facts you may use (use no other facts or numbers):`,
    `- ${facts.seats} seat(s) in ${facts.section}`,
    `- match in ${facts.daysToKickoff} day(s)`,
    channel === "sales_task"
      ? `- section ${facts.sectionSoldPct}% sold; fan has ${facts.lifetimeTickets ?? "unknown"} lifetime tickets; season-pass holder`
      : ``,
    ``,
    `Rules:`,
    `- subject <= ${lim.subject} chars, body <= ${lim.body} chars.`,
    hasCode
      ? `- Include the literal placeholder ${PROMO_PLACEHOLDER} exactly once where the single-use code goes. State the discount as exactly ${(offer as { percentOff: number }).percentOff}%.`
      : `- This offer has NO discount. Do not mention discounts, percentages, deals or promo codes.`,
    `- No prices or dollar amounts. No pressure phrases ("last chance", "act now", "today only"). No invented scarcity.`,
    `- Warm, plain, sounds like the club, not a retailer. No emojis in email subjects.`,
    `Return JSON with "subject" and "body".`,
  ]
    .filter((l) => l !== ``)
    .join("\n");
}

/**
 * Claude via the Claude Agent SDK (runs Claude Code headless with the developer's Claude login, no API key).
 * POC choice. In production, swap in an Anthropic API implementation of CopyModel: same interface,
 * server-side key, no subprocess.
 */
export class ClaudeAgentCopyModel implements CopyModel {
  readonly name: string;
  constructor(private readonly model = process.env.COPY_MODEL ?? "claude-haiku-5-5") {
    this.name = `claude-agent-sdk:${model}`;
  }

  async draft(req: CopyRequest, signal: AbortSignal): Promise<unknown> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const abortController = new AbortController();
    signal.addEventListener("abort", () => abortController.abort(), { once: true });
    const q = query({
      prompt: buildPrompt(req),
      options: {
        model: this.model,
        tools: [], // pure text generation: no file, shell, or web access
        maxTurns: 3,
        settingSources: [], // ignore any local CLAUDE.md / settings
        systemPrompt: "You are a careful marketing copywriter. Follow the rules exactly. Output only the requested JSON.",
        outputFormat: { type: "json_schema", schema: MESSAGE_COPY_JSON_SCHEMA as unknown as Record<string, unknown> },
        abortController,
      },
    });
    for await (const msg of q) {
      if (msg.type === "result") {
        if (msg.subtype !== "success") throw new Error(`model run ended with ${msg.subtype}`);
        if (msg.is_error) throw new Error(`model error: ${msg.result.slice(0, 200)}`);
        if (msg.structured_output !== undefined) return msg.structured_output;
        return JSON.parse(msg.result);
      }
    }
    throw new Error("model returned no result");
  }
}
