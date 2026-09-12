import { NextResponse } from "next/server";
import { KnowledgeBase, loadHousehold } from "@/lib/kb";
import { MessageLog } from "@/lib/sms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET ?userId= returns the household, the text thread, and every knowledge-base document. */
export async function GET(request: Request) {
  const userId = new URL(request.url).searchParams.get("userId") || "maria-demo";
  try {
    const kb = new KnowledgeBase(userId);
    const household = await loadHousehold(kb);
    const messages = await new MessageLog(userId).all();
    const documents = [];
    for (const doc of await kb.list()) documents.push({ ...doc, content: (await kb.read(doc.name)).content });
    return NextResponse.json({
      household: { name: household.name, firstName: household.firstName, phone: household.phone },
      messages,
      documents,
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 404 });
  }
}
