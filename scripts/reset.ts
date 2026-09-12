import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { userDir, usersDir } from "../src/lib/paths";

/**
 * Clears a household's runtime state (message log, conversation session, notes) and
 * restores seed documents from git so the demo starts fresh.
 */
async function resetUser(userId: string): Promise<void> {
  const dir = userDir(userId);
  for (const file of ["messages.jsonl", "session.json", "notes.md"]) {
    await fs.rm(path.join(dir, file), { force: true });
  }
  const restore = spawnSync("git", ["checkout", "--", path.relative(process.cwd(), dir)], { encoding: "utf8" });
  const restored = restore.status === 0;
  console.log(`${userId}: runtime state cleared${restored ? ", seed documents restored from git" : ""}`);
}

async function main(): Promise<void> {
  const arg = process.argv[2] ?? "maria-demo";
  const userIds = arg === "--all"
    ? (await fs.readdir(usersDir(), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
    : [arg];
  for (const userId of userIds) await resetUser(userId);
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
