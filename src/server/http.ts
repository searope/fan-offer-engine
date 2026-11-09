import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { HttpError } from "./service";

/** Every API failure returns a visible, specific error. Nothing is swallowed. */
export async function handle(fn: () => unknown | Promise<unknown>) {
  try {
    return NextResponse.json(await fn());
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message, problems: e.problems }, { status: e.status });
    if (e instanceof ZodError) return NextResponse.json({ error: "Invalid request", problems: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
    console.error(e);
    return NextResponse.json({ error: `Server error: ${(e as Error)?.message ?? e}` }, { status: 500 });
  }
}

/** POC has no auth; the actor comes from a header the UI sets. Production: the signed-in marketer. */
export const actorOf = (req: Request) => req.headers.get("x-actor")?.slice(0, 60) || "marketer";
