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

/** Prints outbound texts to the terminal. Default when Twilio is not configured. */
export class ConsoleSms implements SmsTransport {
  readonly name = "console";
  constructor(private readonly quiet = false) {}
  async send(to: string, body: string): Promise<void> {
    if (!this.quiet) console.log(`\n📱  Copilot → ${to}\n    ${body.replace(/\n/g, "\n    ")}\n`);
  }
}

/** Real SMS through Twilio's REST API. Enabled when the three TWILIO_* variables are set. */
export class TwilioSms implements SmsTransport {
  readonly name = "twilio";
  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly from: string,
  ) {}

  async send(to: string, body: string): Promise<void> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: to, From: this.from, Body: body }),
    });
    if (!response.ok) throw new Error(`Twilio rejected the message (${response.status}): ${await response.text()}`);
  }
}

export function smsTransportFromEnv(options: { quiet?: boolean } = {}): SmsTransport {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER } = process.env;
  if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER) {
    return new TwilioSms(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER);
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
