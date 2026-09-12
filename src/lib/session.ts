import fs from "node:fs/promises";
import path from "node:path";
import type { AgentInputItem, Session } from "@openai/agents";
import { userDir } from "./paths";

/**
 * Conversation history for one household, stored as JSON next to their documents.
 * Implements the Agents SDK Session interface so `run()` loads and saves it automatically.
 */
export class FileSession implements Session {
  readonly file: string;

  constructor(private readonly sessionId: string, file?: string) {
    this.file = file ?? path.join(userDir(sessionId), "session.json");
  }

  private async load(): Promise<AgentInputItem[]> {
    try {
      return JSON.parse(await fs.readFile(this.file, "utf8")) as AgentInputItem[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async save(items: AgentInputItem[]): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(items, null, 2), "utf8");
    await fs.rename(tmp, this.file);
  }

  async getSessionId(): Promise<string> {
    return this.sessionId;
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    const items = await this.load();
    return typeof limit === "number" && limit >= 0 ? items.slice(-limit) : items;
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    if (items.length === 0) return;
    const existing = await this.load();
    await this.save([...existing, ...items]);
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    const items = await this.load();
    const last = items.pop();
    await this.save(items);
    return last;
  }

  async clearSession(): Promise<void> {
    await fs.rm(this.file, { force: true });
  }
}
