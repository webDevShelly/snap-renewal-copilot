export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Vonage answer webhook for calls placed TO the number. Outbound calls carry their own NCCO and never hit this. */
export async function GET() {
  return Response.json([
    { action: "talk", language: "en-US", text: "This is the SNAP Renewal Copilot demo line. Please reply by text message instead." },
  ]);
}
export const POST = GET;
