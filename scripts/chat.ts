import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadEnv } from "./env";
import { renewalSweepEvent, runTurn } from "../src/lib/agent";
import { KnowledgeBase, loadHousehold } from "../src/lib/kb";
import { MessageLog, type TextMessage } from "../src/lib/sms";
import type { TurnInput } from "../src/lib/types";

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;

function printMessage(message: TextMessage): void {
  const when = new Date(message.at).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "short", timeStyle: "short" });
  const who = message.direction === "outbound" ? "📱  Copilot" : "💬  Household";
  console.log(`${dim(when)}  ${who}: ${message.body}`);
}

async function main(): Promise<void> {
  loadEnv();
  const args = process.argv.slice(2);
  const userId = args.find((arg) => !arg.startsWith("--")) ?? "maria-demo";
  const household = await loadHousehold(new KnowledgeBase(userId));

  const history = await new MessageLog(userId).all();
  if (history.length > 0) {
    console.log(dim(`--- last ${Math.min(history.length, 8)} of ${history.length} messages ---`));
    history.slice(-8).forEach(printMessage);
  }
  console.log(`\nYou are texting as ${household.name} (${household.phone}).`);
  console.log(dim(`Type a message and press Enter. "/sweep" runs the renewal sweep, "exit" quits.\n`));

  async function turn(input: TurnInput): Promise<void> {
    const started = Date.now();
    try {
      const result = await runTurn(userId, input);
      if (result.sent.length === 0) console.log(dim("(agent sent no text)"));
      console.log(dim(`· ${result.summary || "(no internal note)"}`));
      console.log(dim(`· tools: ${result.toolCalls.join(", ") || "none"} · ${((Date.now() - started) / 1000).toFixed(1)}s\n`));
    } catch (error) {
      console.error(`\n✖ ${(error as Error).message}\n`);
    }
  }

  if (args.includes("--sweep")) await turn({ kind: "event", ...renewalSweepEvent() });

  // The async iterator buffers lines that arrive while a turn is running, so piped input
  // (printf 'a\nb\nexit\n' | npm run chat) works as well as an interactive terminal.
  const interactive = Boolean(stdin.isTTY);
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: interactive });
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });
  const prompt = () => {
    if (!closed) rl.prompt();
  };
  rl.setPrompt(`${household.firstName}> `);
  prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) {
      prompt();
      continue;
    }
    if (line === "exit" || line === "quit") break;
    if (!interactive) console.log(`💬  ${household.firstName}: ${line}`);
    if (line === "/sweep") await turn({ kind: "event", ...renewalSweepEvent() });
    else await turn({ kind: "inbound_text", body: line });
    prompt();
  }
  if (!closed) rl.close();
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
