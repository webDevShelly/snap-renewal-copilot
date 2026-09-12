import fs from "node:fs/promises";
import { loadEnv } from "./env";
import { renewalSweepEvent, runTurn } from "../src/lib/agent";
import { usersDir } from "../src/lib/paths";

/** Runs the renewal sweep for every household folder under data/users. Wire this to a scheduler in production. */
async function main(): Promise<void> {
  loadEnv();
  const only = process.argv[2];
  const userIds = only ? [only] : (await fs.readdir(usersDir(), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  for (const userId of userIds) {
    console.log(`\n=== ${userId} ===`);
    try {
      const result = await runTurn(userId, { kind: "event", ...renewalSweepEvent() });
      console.log(`texts sent: ${result.sent.length}`);
      console.log(`note: ${result.summary || "(none)"}`);
    } catch (error) {
      console.error(`✖ ${(error as Error).message}`);
      process.exitCode = 1;
    }
  }
}

main();
