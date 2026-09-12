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

/**
 * Real SMS through Twilio's REST API. Authenticates with the account SID + auth token, or with
 * a Twilio API key SID (SK...) + secret when no auth token is configured.
 */
export class TwilioSms implements SmsTransport {
  readonly name = "twilio";
  constructor(
    private readonly accountSid: string,
    private readonly authUser: string,
    private readonly authSecret: string,
    private readonly from: string,
  ) {}

  async send(to: string, body: string): Promise<void> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.authUser}:${this.authSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: to, From: this.from, Body: body }),
    });
    if (!response.ok) throw new Error(`Twilio rejected the message (${response.status}): ${await response.text()}`);
  }
}

/**
 * Twilio when configured, otherwise the console. Accepts either TWILIO_FROM_NUMBER or
 * TWILIO_PHONE_NUMBER for the sender, and either an auth token or an API key SID + secret.
 */
export function smsTransportFromEnv(options: { quiet?: boolean } = {}): SmsTransport {
  const env = process.env;
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const from = env.TWILIO_FROM_NUMBER || env.TWILIO_PHONE_NUMBER;
  const authUser = env.TWILIO_AUTH_TOKEN ? accountSid : env.TWILIO_API_KEY_SID;
  const authSecret = env.TWILIO_AUTH_TOKEN || env.TWILIO_API_KEY_SECRET;
  if (accountSid && from && authUser && authSecret) {
    return new TwilioSms(accountSid, authUser, authSecret, from);
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
