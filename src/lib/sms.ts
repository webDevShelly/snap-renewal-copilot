import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { userDir } from "./paths";

export type TextMessage = {
  id: string;
  at: string;
  direction: "outbound" | "inbound";
  phone: string;
  body: string;
  channel: string;
};

export interface SmsTransport {
  readonly name: string;
  send(to: string, body: string): Promise<void>;
}

/** Prints outbound texts to the terminal. Default when no SMS provider is configured. */
export class ConsoleSms implements SmsTransport {
  readonly name = "console";
  constructor(private readonly quiet = false) {}
  async send(to: string, body: string): Promise<void> {
    if (!this.quiet) console.log(`\n📱  Copilot → ${to}\n    ${body.replace(/\n/g, "\n    ")}\n`);
  }
}

/**
 * Vonage sends plain "text" messages in the 7-bit GSM alphabet, which has no curly quotes or
 * long dashes; those arrive on the handset as "?". Map them to ASCII before sending.
 */
export function toGsmSafe(body: string): string {
  return body
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ");
}

type VonageSmsResponse = {
  messages?: Array<{ status?: string | number; "error-text"?: string; "message-id"?: string }>;
  "error-code-label"?: string;
};

/**
 * Real SMS through the Vonage SMS API. Same request shape as the sms/ service, so both apps
 * can share one Vonage account and sender.
 */
export class VonageSms implements SmsTransport {
  readonly name = "vonage";
  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly from: string,
  ) {}

  async send(to: string, body: string): Promise<void> {
    const response = await fetch("https://rest.nexmo.com/sms/json", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.apiKey}:${this.apiSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ from: this.from, to: to.replace(/^\+/, ""), text: toGsmSafe(body) }),
    });
    const result = (await response.json().catch(() => ({}))) as VonageSmsResponse;
    const message = result.messages?.[0];
    if (!response.ok || !message || String(message.status) !== "0") {
      const detail = message?.["error-text"] ?? result["error-code-label"] ?? `HTTP ${response.status}`;
      throw new Error(`Vonage rejected the message: ${detail}`);
    }
  }
}

/** Vonage when VONAGE_API_KEY, VONAGE_API_SECRET, and VONAGE_SENDER are set; otherwise the console. */
export function smsTransportFromEnv(options: { quiet?: boolean } = {}): SmsTransport {
  const { VONAGE_API_KEY, VONAGE_API_SECRET, VONAGE_SENDER } = process.env;
  if (VONAGE_API_KEY && VONAGE_API_SECRET && VONAGE_SENDER) {
    return new VonageSms(VONAGE_API_KEY, VONAGE_API_SECRET, VONAGE_SENDER);
  }
  return new ConsoleSms(options.quiet);
}

/** Append-only log of every text in and out, one JSON object per line. */
export class MessageLog {
  readonly file: string;

  constructor(readonly userId: string) {
    this.file = path.join(userDir(userId), "messages.jsonl");
  }

  async append(message: Omit<TextMessage, "id" | "at"> & Partial<Pick<TextMessage, "id" | "at">>): Promise<TextMessage> {
    const full: TextMessage = { id: randomUUID(), at: new Date().toISOString(), ...message };
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.appendFile(this.file, `${JSON.stringify(full)}\n`, "utf8");
    return full;
  }

  async all(): Promise<TextMessage[]> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as TextMessage);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
