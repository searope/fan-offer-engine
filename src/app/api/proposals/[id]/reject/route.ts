import { z } from "zod";
import { actorOf, handle } from "@/server/http";
import { reject, REJECT_REASONS } from "@/server/service";

const Body = z.object({ reason: z.enum(REJECT_REASONS), note: z.string().max(500).default("") });

export const POST = (req: Request, ctx: RouteContext<"/api/proposals/[id]/reject">) =>
  handle(async () => {
    const b = Body.parse(await req.json());
    return reject(Number((await ctx.params).id), b.reason, b.note, actorOf(req));
  });
