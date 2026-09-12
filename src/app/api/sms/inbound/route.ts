import { runTurn } from "@/lib/agent";
import { findUserByPhone } from "@/lib/kb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const twiml = (status = 200) => new Response("<Response></Response>", { status, headers: { "Content-Type": "text/xml" } });

/**
 * Twilio inbound-SMS webhook. Point your Twilio number's messaging webhook here.
 * The agent replies through its own send_text_message tool, so the TwiML response stays empty.
 * Demo only: add Twilio request-signature validation before exposing this publicly.
 */
export async function POST(request: Request) {
  const form = await request.formData();
  const from = String(form.get("From") ?? "");
  const body = String(form.get("Body") ?? "").trim();
  if (!from || !body) return twiml(400);

  const userId = await findUserByPhone(from);
  if (!userId) return twiml(404);

  try {
    await runTurn(userId, { kind: "inbound_text", body }, { quiet: true });
    return twiml();
  } catch (error) {
    console.error("inbound sms failed", error);
    return twiml(500);
  }
}
