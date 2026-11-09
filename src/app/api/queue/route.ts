import { connection } from "next/server";
import { handle } from "@/server/http";
import { queue } from "@/server/service";

// Synchronous node:sqlite reads must opt out of prerendering (Cache Components).
export const GET = () =>
  handle(async () => {
    await connection();
    return queue();
  });
