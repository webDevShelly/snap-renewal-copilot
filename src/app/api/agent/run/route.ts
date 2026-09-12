import { NextResponse } from "next/server";
import { renewalSweepEvent, runTurn } from "@/lib/agent";
import type { TurnInput } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST { userId?, message } for an inbound text, or { userId?, event: "renewal_sweep" } for the scheduled sweep. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { userId?: unknown; message?: unknown; event?: unknown };
  const userId = typeof body.userId === "string" && body.userId ? body.userId : "maria-demo";

  let input: TurnInput | null = null;
  if (typeof body.message === "string" && body.message.trim()) input = { kind: "inbound_text", body: body.message.trim() };
  else if (body.event === "renewal_sweep") input = { kind: "event", ...renewalSweepEvent() };
  if (!input) return NextResponse.json({ error: 'Send { message } or { event: "renewal_sweep" }.' }, { status: 400 });

  try {
    return NextResponse.json(await runTurn(userId, input, { quiet: true }));
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
