import { runTurn } from "@/lib/agent";
import { findUserByPhone } from "@/lib/kb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Vonage inbound-SMS webhook. Set your Vonage number's inbound URL to this route.
 * The SMS API delivers `msisdn` (sender) and `text` by GET or POST; the Messages API posts JSON
 * with `from.number` and `text`. Both are accepted. Always answer 200 so Vonage does not retry.
 * The agent replies through its own send_text_message tool.
 * Demo only: add Vonage signature verification before exposing this route publicly.
 */
async function parseInbound(request: Request): Promise<{ from: string; text: string }> {
  let params: Record<string, unknown> = Object.fromEntries(new URL(request.url).searchParams);
  if (request.method === "POST") {
    const type = request.headers.get("content-type") ?? "";
    if (type.includes("json")) {
      params = { ...params, ...((await request.json().catch(() => ({}))) as Record<string, unknown>) };
    } else if (type.includes("form")) {
      params = { ...params, ...Object.fromEntries(await request.formData()) };
    }
  }
  const sender = params.msisdn ?? params.from;
  const from = typeof sender === "string" ? sender : String((sender as { number?: string } | undefined)?.number ?? "");
  return { from, text: String(params.text ?? "").trim() };
}

async function handle(request: Request): Promise<Response> {
  const { from, text } = await parseInbound(request);
  if (!from || !text) return new Response("ignored", { status: 200 });

  const userId = await findUserByPhone(from);
  if (!userId) return new Response("unknown sender", { status: 200 });

  try {
    await runTurn(userId, { kind: "inbound_text", body: text }, { quiet: true });
  } catch (error) {
    console.error("inbound sms failed", error);
  }
  return new Response("ok", { status: 200 });
}

export const GET = handle;
export const POST = handle;
