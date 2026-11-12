import { connection } from "next/server";
import { handle } from "@/server/http";
import { queue } from "@/server/service";

// Synchronous node:sqlite reads must opt out of prerendering (Cache Components). connection() signals that
// by rejecting during the build's prerender, so it is awaited *outside* handle(): handle() would catch that
// signal and log it as a server error.
export const GET = async () => {
  await connection();
  return handle(() => queue());
};
