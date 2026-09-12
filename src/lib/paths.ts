import path from "node:path";

/** Root of the local knowledge base. Override with DATA_DIR for tests or alternate seeds. */
export function dataDir(): string {
  return path.resolve(process.env.DATA_DIR ?? path.join(process.cwd(), "data"));
}

export function sharedDir(): string {
  return path.join(dataDir(), "shared");
}

export function usersDir(): string {
  return path.join(dataDir(), "users");
}

export function assertUserId(userId: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(userId)) throw new Error(`Invalid user id: ${userId}`);
  return userId;
}

export function userDir(userId: string): string {
  return path.join(usersDir(), assertUserId(userId));
}

/** Files in a user folder that are runtime state, not knowledge-base documents. */
export const RUNTIME_FILES = new Set(["messages.jsonl", "session.json"]);
