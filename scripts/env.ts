import fs from "node:fs";

/** Load .env.local then .env without overriding variables already in the environment. */
export function loadEnv(): void {
  for (const file of [".env.local", ".env"]) {
    if (!fs.existsSync(file)) continue;
    try {
      process.loadEnvFile(file);
    } catch (error) {
      console.warn(`Could not load ${file}: ${(error as Error).message}`);
    }
  }
}
