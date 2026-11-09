import { actorOf, handle } from "@/server/http";
import { edit, EditSchema } from "@/server/service";

export const PATCH = (req: Request, ctx: RouteContext<"/api/proposals/[id]">) =>
  handle(async () => edit(Number((await ctx.params).id), EditSchema.parse(await req.json()), actorOf(req)));
