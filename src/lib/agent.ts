import {
  Agent,
  run,
  tool,
  defineToolInputGuardrail,
  ToolGuardrailFunctionOutputFactory,
  type Model,
  type RunContext,
} from "@openai/agents";
import { z } from "zod";
import { KnowledgeBase, loadHousehold, type Household } from "./kb";
import { MessageLog, smsTransportFromEnv, type SmsTransport, type TextMessage } from "./sms";
import { FileSession } from "./session";
import type { TurnInput, TurnResult } from "./types";

/** Everything a tool can reach during one run. Passed as the Agents SDK run context. */
export type CopilotContext = {
  userId: string;
  kb: KnowledgeBase;
  household: Household;
  sms: SmsTransport;
  log: MessageLog;
  sentThisTurn: TextMessage[];
  today: string;
};

function ctxOf(runContext: RunContext<CopilotContext> | undefined): CopilotContext {
  if (!runContext?.context) throw new Error("Tool was invoked without a copilot context");
  return runContext.context;
}

// --- Guardrail on the only channel the household can hear ----------------------------------

const DOLLAR_AMOUNT = /\$\s?\d|\b\d+(?:\.\d+)?\s?(?:dollars|bucks)\b/i;
const ELIGIBILITY_VERDICT =
  /\byou(?:'re| are| will be| won't be| will not be| aren't| are not|'ll be)\s+(?:not\s+|still\s+|definitely\s+)?(?:eligible|ineligible|approved|denied|qualified)\b/i;
const CREDENTIAL_ASK = /\b(?:ssn|social security (?:number|#)|pin\b|password|passcode|ebt (?:card )?number|card number)\b/i;

const { allow, rejectContent } = ToolGuardrailFunctionOutputFactory;

export const householdTextGuardrail = defineToolInputGuardrail<CopilotContext>({
  name: "household_text_safety",
  run: async ({ toolCall }) => {
    let body = "";
    try {
      body = String((JSON.parse(toolCall.arguments) as { body?: unknown }).body ?? "");
    } catch {
      return rejectContent("send_text_message arguments must be JSON with a string body.");
    }
    if (!body.trim()) return rejectContent("Empty message. Say something useful or send nothing.");
    if (body.length > 480) {
      return rejectContent(
        `That text is ${body.length} characters. Keep each text under 300 characters; split it into two texts.`,
      );
    }
    if (DOLLAR_AMOUNT.test(body)) {
      return rejectContent(
        "Blocked: do not quote dollar amounts. HRA calculates benefits. Point to the amount printed on their notice or say HRA will tell them.",
      );
    }
    if (ELIGIBILITY_VERDICT.test(body)) {
      return rejectContent(
        "Blocked: do not tell the household whether they are eligible, approved, or denied. Only HRA decides. Describe the next step and how they will hear the decision.",
      );
    }
    if (CREDENTIAL_ASK.test(body)) {
      return rejectContent(
        "Blocked: never mention or ask for SSN, PIN, password, or card numbers over text. Ask for documents through ACCESS HRA instead.",
      );
    }
    return allow();
  },
});

// --- Tools -------------------------------------------------------------------------------

const sendTextMessage = tool({
  name: "send_text_message",
  description:
    "Send one SMS to the household's phone. This is the ONLY way the household can hear from you. Under 300 characters, plain words, one question or one ask per text. Send two short texts rather than one long one.",
  parameters: z.object({
    body: z.string().describe("The text message. Plain language a tired parent can act on from their phone."),
  }),
  inputGuardrails: [householdTextGuardrail],
  execute: async ({ body }, runContext?: RunContext<CopilotContext>) => {
    const ctx = ctxOf(runContext);
    await ctx.sms.send(ctx.household.phone, body);
    const message = await ctx.log.append({
      direction: "outbound",
      phone: ctx.household.phone,
      body,
      channel: ctx.sms.name,
    });
    ctx.sentThisTurn.push(message);
    return { delivered: true, at: message.at, to: ctx.household.phone };
  },
});

const listDocuments = tool({
  name: "list_documents",
  description:
    "List every document in this household's knowledge base plus the shared SNAP reference docs (names starting with shared/). Call this first if you are unsure what is on file.",
  parameters: z.object({}),
  execute: async (_input, runContext?: RunContext<CopilotContext>) => ctxOf(runContext).kb.list(),
});

const readDocument = tool({
  name: "read_document",
  description: "Read the full text of one document by name, e.g. case.md, documents.md, notices/2026-09-recert-packet.md, shared/snap-basics.md.",
  parameters: z.object({ name: z.string().describe("Document name exactly as returned by list_documents") }),
  execute: async ({ name }, runContext?: RunContext<CopilotContext>) => ctxOf(runContext).kb.read(name),
});

const searchDocuments = tool({
  name: "search_documents",
  description:
    "Keyword search across all of this household's documents and the shared reference. Returns matching lines with document name and line number. Good for finding a phone number, a date, or a document's status.",
  parameters: z.object({ query: z.string().describe("One or more keywords, e.g. 'interview date' or 'pay stub'") }),
  execute: async ({ query }, runContext?: RunContext<CopilotContext>) => ctxOf(runContext).kb.search(query),
});

const saveNote = tool({
  name: "save_note",
  description:
    "Append a dated note to notes.md, your running memory about this household. Use it whenever the household tells you something new: a document they sent, a changed plan, a question you could not answer, a promise you made.",
  parameters: z.object({ note: z.string().describe("One or two sentences of fact, not speculation.") }),
  execute: async ({ note }, runContext?: RunContext<CopilotContext>) => ctxOf(runContext).kb.appendNote(note),
});

const PROTECTED_DOCS = new Set(["profile.md", "notes.md"]);

const updateDocument = tool({
  name: "update_document",
  description:
    "Replace the full contents of one of the household's documents, for example to change a row in documents.md from Missing to Received. Read the document first and write back the whole file with your edit. profile.md and notes.md cannot be edited this way; shared/ docs are read-only.",
  parameters: z.object({
    name: z.string().describe("Document name exactly as returned by list_documents"),
    content: z.string().describe("The complete new markdown content of the document"),
  }),
  execute: async ({ name, content }, runContext?: RunContext<CopilotContext>) => {
    const normalized = name.replace(/^\.?\//, "");
    if (PROTECTED_DOCS.has(normalized)) {
      throw new Error(`${normalized} is protected. Use save_note to record what changed.`);
    }
    return ctxOf(runContext).kb.write(name, content);
  },
});

// --- Agent -------------------------------------------------------------------------------

function buildInstructions(ctx: CopilotContext): string {
  return `You are the SNAP Renewal Copilot for one New York City household. Your job is to keep their SNAP benefits from lapsing at recertification by making sure the form, the interview, and the proof documents happen on time.

Today is ${ctx.today}.

Household you are helping:
${ctx.household.profile.trim()}

## How you communicate
- The household can ONLY hear you through the send_text_message tool. Anything you write outside that tool is an internal note for the operator log; the household never sees it.
- Text like a helpful caseworker friend: plain words, short sentences, no jargon, no acronyms without saying what they mean. One question or one ask per text. Under 300 characters each. Two short texts beat one long one.
- Every text must move them toward a concrete next step: the thing to do, where to do it, and by when. Prefer a real date over "soon".
- Match their language preference. Do not send a text that repeats something you already told them unless a deadline is close.

## Knowledge base
- Before texting, read the household's documents (list_documents, read_document, search_documents). case.md says what is due and when; documents.md says what is missing; notices/ holds what HRA actually sent them.
- shared/ documents are program reference. Take phone numbers, rules, and deadlines from there, not from memory. If the answer is not in the knowledge base, say you are not sure and give the NYC SNAP line from shared/snap-basics.md.
- When the household tells you something new (a document sent, an interview missed, a changed phone), record it with save_note and update the relevant row in documents.md with update_document, so the next run starts from the truth.

## Hard limits
- Never say whether they are or are not eligible, approved, or denied, and never quote a benefit dollar amount. HRA decides; you explain what to do and how they will hear.
- Never submit, sign, or promise to submit anything on their behalf. The household files their own recertification through ACCESS HRA, by mail, or at a center. You prepare and remind.
- Never ask for passwords, PINs, EBT card numbers, or Social Security numbers.
- Do not invent HRA phone numbers, addresses, or deadlines.

## Each turn
- Input is either an inbound text from the household or a system event such as the daily renewal sweep.
- On a sweep, check what is due within the next 60 days and what is still missing. Reach out only if there is something they need to do and you have not already asked recently, or a deadline is within 7 days. A sweep with nothing new should send no text.
- On an inbound text, answer the question or acknowledge what they did, update the knowledge base, and tell them the single next step.
- Finish with one internal line (not a text) summarizing what you did and what you are waiting on.`;
}

export function createCopilotAgent(options: { model?: string | Model } = {}): Agent<CopilotContext> {
  return new Agent<CopilotContext>({
    name: "SNAP Renewal Copilot",
    instructions: (runContext) => buildInstructions(runContext.context),
    tools: [sendTextMessage, listDocuments, readDocument, searchDocuments, saveNote, updateDocument],
    // The SDK picks its default model (or OPENAI_DEFAULT_MODEL) when none is given.
    ...(options.model ? { model: options.model } : {}),
  });
}

// --- Running a turn ------------------------------------------------------------------------

function formatDay(date: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "America/New_York",
  });
}

function stamp(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" });
}

/** The scheduled event that wakes the agent to look for upcoming deadlines. */
export function renewalSweepEvent(): { name: string; detail: string } {
  return {
    name: "renewal_sweep",
    detail:
      "Daily renewal sweep. Read case.md and documents.md. Decide whether this household needs a nudge today, and if so send it. Otherwise send nothing.",
  };
}

export type RunTurnOptions = {
  transport?: SmsTransport;
  /** Suppress console printing of outbound texts (used by the web UI). */
  quiet?: boolean;
  maxTurns?: number;
  /** Override the model, e.g. a scripted fake in tests. */
  model?: string | Model;
};

export async function runTurn(userId: string, input: TurnInput, options: RunTurnOptions = {}): Promise<TurnResult> {
  if (!process.env.OPENAI_API_KEY && typeof options.model !== "object") {
    throw new Error("OPENAI_API_KEY is not set. Copy .env.example to .env.local and add your key.");
  }
  const kb = new KnowledgeBase(userId);
  const household = await loadHousehold(kb);
  const log = new MessageLog(userId);
  const sms = options.transport ?? smsTransportFromEnv({ quiet: options.quiet });
  const now = new Date();
  const ctx: CopilotContext = { userId, kb, household, sms, log, sentThisTurn: [], today: formatDay(now) };

  let message: string;
  if (input.kind === "inbound_text") {
    const logged = await log.append({ direction: "inbound", phone: household.phone, body: input.body, channel: sms.name });
    message = `Inbound text from ${household.firstName} (${household.phone}) at ${stamp(logged.at)}:\n"""\n${input.body}\n"""`;
  } else {
    message = `System event "${input.name}" at ${stamp(now.toISOString())}.\n${input.detail ?? ""}`.trim();
  }

  const result = await run(createCopilotAgent({ model: options.model }), message, {
    context: ctx,
    session: new FileSession(userId),
    maxTurns: options.maxTurns ?? 15,
  });

  const toolCalls = result.newItems
    .filter((item) => item.type === "tool_call_item")
    .map((item) => ("name" in item.rawItem && typeof item.rawItem.name === "string" ? item.rawItem.name : item.rawItem.type));

  return {
    userId,
    summary: typeof result.finalOutput === "string" ? result.finalOutput.trim() : "",
    sent: ctx.sentThisTurn,
    toolCalls,
  };
}
