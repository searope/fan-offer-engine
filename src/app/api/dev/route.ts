import { z } from "zod";
import { actorOf, handle } from "@/server/http";
import { advanceClock, completeCart, resetDemo, setConsent, setOutage } from "@/server/service";

/** Demo controls (reset, move the clock, change consent, simulate a provider outage). Not shipped to production. */
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reset") }),
  z.object({ action: z.literal("advance_clock"), days: z.number().int().min(1).max(30) }),
  z.object({ action: z.literal("set_consent"), fanId: z.string(), channel: z.enum(["email", "push"]), value: z.boolean() }),
  z.object({ action: z.literal("set_outage"), channel: z.enum(["email", "push"]), on: z.boolean() }),
  z.object({ action: z.literal("complete_cart"), fanId: z.string() }),
]);

export const POST = (req: Request) =>
  handle(async () => {
    if (process.env.NODE_ENV === "production" && process.env.ENABLE_DEMO_CONTROLS !== "1") throw new Error("Demo controls are disabled");
    const b = Body.parse(await req.json());
    if (b.action === "reset") resetDemo();
    if (b.action === "advance_clock") advanceClock(b.days);
    if (b.action === "set_consent") setConsent(b.fanId, b.channel, b.value, actorOf(req));
    if (b.action === "set_outage") setOutage(b.channel, b.on);
    if (b.action === "complete_cart") completeCart(b.fanId, actorOf(req));
    return { ok: true };
  });
