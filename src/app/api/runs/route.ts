import { actorOf, handle } from "@/server/http";
import { runEngine } from "@/server/service";

export const POST = (req: Request) => handle(() => runEngine(actorOf(req)));
