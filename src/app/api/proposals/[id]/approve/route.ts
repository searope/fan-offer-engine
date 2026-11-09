import { actorOf, handle } from "@/server/http";
import { approve } from "@/server/service";

/** Approve = send now (POC). Also used to retry a failed send; the outbox key makes it idempotent. */
export const POST = (req: Request, ctx: RouteContext<"/api/proposals/[id]/approve">) =>
  handle(async () => approve(Number((await ctx.params).id), actorOf(req)));
