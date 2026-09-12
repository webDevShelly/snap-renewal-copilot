import fs from "node:fs";
import { createSign, randomUUID } from "node:crypto";

export interface VoiceTransport {
  readonly name: string;
  /** Ring `to` and read `script` aloud with text-to-speech. */
  call(to: string, script: string): Promise<{ callId?: string }>;
  /** Ring `office`, read `intro` aloud, then ring `household` into the same call so the two can talk. */
  bridge(office: string, intro: string, household: string): Promise<{ callId?: string }>;
}

/** Prints the call instead of placing it. Default when Vonage voice is not configured. */
export class ConsoleVoice implements VoiceTransport {
  readonly name = "console";
  constructor(private readonly quiet = false) {}
  async call(to: string, script: string): Promise<{ callId?: string }> {
    if (!this.quiet) console.log(`\n📞  Copilot calls ${to}\n    "${script}"\n`);
    return {};
  }
  async bridge(office: string, intro: string, household: string): Promise<{ callId?: string }> {
    if (!this.quiet) console.log(`\n📞  Copilot calls SNAP at ${office}: "${intro}" then connects ${household}\n`);
    return {};
  }
}

/** RS256 JWT for the Vonage Voice API, signed with the application's private key. */
export function vonageJwt(applicationId: string, privateKeyPem: string, ttlSeconds = 300): string {
  const encode = (value: string | Buffer) => Buffer.from(value).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = encode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = encode(
    JSON.stringify({ application_id: applicationId, iat: now, exp: now + ttlSeconds, jti: randomUUID() }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${encode(signer.sign(privateKeyPem))}`;
}

type VonageCallResponse = { uuid?: string; title?: string; detail?: string; error_title?: string };

/** Outbound call through the Vonage Voice API with an inline text-to-speech NCCO. */
export class VonageVoice implements VoiceTransport {
  readonly name = "vonage";
  constructor(
    private readonly applicationId: string,
    private readonly privateKeyPem: string,
    private readonly from: string,
  ) {}

  private async createCall(to: string, ncco: Array<Record<string, unknown>>): Promise<{ callId?: string }> {
    const response = await fetch("https://api.nexmo.com/v1/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${vonageJwt(this.applicationId, this.privateKeyPem)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: [{ type: "phone", number: to.replace(/^\+/, "") }],
        from: { type: "phone", number: this.from.replace(/^\+/, "") },
        ncco,
      }),
    });
    const result = (await response.json().catch(() => ({}))) as VonageCallResponse;
    if (!response.ok) {
      throw new Error(`Vonage rejected the call (${response.status}): ${result.title ?? result.error_title ?? result.detail ?? "unknown error"}`);
    }
    return { callId: result.uuid };
  }

  async call(to: string, script: string): Promise<{ callId?: string }> {
    return this.createCall(to, [{ action: "talk", text: script, language: "en-US", style: 0 }]);
  }

  /** The office leg hears the intro while the household's phone rings; Vonage joins them when answered. */
  async bridge(office: string, intro: string, household: string): Promise<{ callId?: string }> {
    return this.createCall(office, [
      { action: "talk", text: intro, language: "en-US", style: 0 },
      { action: "talk", text: "Please hold while I connect them now.", language: "en-US", style: 0 },
      {
        action: "connect",
        from: this.from.replace(/^\+/, ""),
        timeout: 45,
        endpoint: [{ type: "phone", number: household.replace(/^\+/, "") }],
      },
    ]);
  }
}

/**
 * Vonage voice when VONAGE_APPLICATION_ID, a private key (VONAGE_PRIVATE_KEY or the file at
 * VONAGE_PRIVATE_KEY_PATH), and VONAGE_SENDER are all set; otherwise the console.
 */
export function voiceTransportFromEnv(options: { quiet?: boolean } = {}): VoiceTransport {
  const { VONAGE_APPLICATION_ID, VONAGE_PRIVATE_KEY, VONAGE_PRIVATE_KEY_PATH, VONAGE_SENDER } = process.env;
  let pem = VONAGE_PRIVATE_KEY;
  if (!pem && VONAGE_PRIVATE_KEY_PATH && fs.existsSync(VONAGE_PRIVATE_KEY_PATH)) {
    pem = fs.readFileSync(VONAGE_PRIVATE_KEY_PATH, "utf8");
  }
  if (VONAGE_APPLICATION_ID && pem && VONAGE_SENDER) return new VonageVoice(VONAGE_APPLICATION_ID, pem, VONAGE_SENDER);
  return new ConsoleVoice(options.quiet);
}

/** Calls are only placed inside this New York hour window, "8-21" unless COPILOT_CALL_WINDOW overrides it. */
export function withinCallWindow(now = new Date()): boolean {
  const [start, end] = (process.env.COPILOT_CALL_WINDOW ?? "8-21").split("-").map(Number);
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: "America/New_York" }).format(now),
  );
  return hour >= start && hour < end;
}
