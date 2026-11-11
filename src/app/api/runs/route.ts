import { z } from "zod";
import { actorOf, handle } from "@/server/http";
import { runEngine } from "@/server/service";

/** Optional body: { overrideReason } to run on an export that failed its checks. The reason is audited. */
const Body = z.object({ overrideReason: z.string().trim().min(10, "Give a reason of at least 10 characters").max(300).optional() });

export const POST = (req: Request) =>
  handle(async () => {
    const text = await req.text();
    const body = Body.parse(text ? JSON.parse(text) : {});
    return runEngine(actorOf(req), { overrideReason: body.overrideReason });
  });
