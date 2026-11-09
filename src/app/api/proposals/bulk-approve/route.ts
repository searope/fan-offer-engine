import { z } from "zod";
import { actorOf, handle } from "@/server/http";
import { bulkApprove } from "@/server/service";

const Body = z.object({ ids: z.array(z.number().int()).min(1).max(100) });

/** Approve several no-discount reminders at once. The server re-checks eligibility per id; the client list isn't trusted. */
export const POST = (req: Request) => handle(async () => bulkApprove(Body.parse(await req.json()).ids, actorOf(req)));
