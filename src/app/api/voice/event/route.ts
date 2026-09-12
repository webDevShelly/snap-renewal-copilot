export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Vonage call-status events (ringing, answered, completed). Acknowledged and otherwise ignored. */
export async function POST() {
  return new Response(null, { status: 204 });
}
export const GET = POST;
