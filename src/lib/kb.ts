import fs from "node:fs/promises";
import path from "node:path";
import { RUNTIME_FILES, sharedDir, userDir, usersDir } from "./paths";

export type DocScope = "user" | "shared";

export type DocSummary = {
  name: string;
  scope: DocScope;
  title: string;
  bytes: number;
};

export type SearchHit = {
  name: string;
  line: number;
  text: string;
};

function normalizeName(name: string): string {
  const cleaned = name.trim().replace(/\\/g, "/").replace(/^\.?\//, "");
  if (!cleaned || cleaned.includes("..") || cleaned.includes("\0")) {
    throw new Error(`Invalid document name: ${JSON.stringify(name)}`);
  }
  return cleaned.endsWith(".md") ? cleaned : `${cleaned}.md`;
}

async function walkMarkdown(root: string, prefix = ""): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const names: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) names.push(...(await walkMarkdown(path.join(root, entry.name), rel)));
    else if (entry.name.endsWith(".md") && !RUNTIME_FILES.has(entry.name)) names.push(rel);
  }
  return names;
}

function titleOf(content: string, fallback: string): string {
  const heading = content.split("\n").find((line) => line.startsWith("# "));
  return heading ? heading.slice(2).trim() : fallback;
}

/**
 * A household's knowledge base: markdown files under data/users/<id>/ (read/write)
 * plus program reference under data/shared/ exposed as "shared/<name>" (read-only).
 */
export class KnowledgeBase {
  readonly root: string;

  constructor(readonly userId: string) {
    this.root = userDir(userId);
  }

  private locate(name: string): { file: string; scope: DocScope; name: string } {
    const normalized = normalizeName(name);
    if (normalized.startsWith("shared/")) {
      const base = sharedDir();
      const file = path.resolve(base, normalized.slice("shared/".length));
      if (!file.startsWith(base + path.sep)) throw new Error("Document name escapes the shared folder");
      return { file, scope: "shared", name: normalized };
    }
    const file = path.resolve(this.root, normalized);
    if (!file.startsWith(this.root + path.sep)) throw new Error("Document name escapes the household folder");
    return { file, scope: "user", name: normalized };
  }

  async list(): Promise<DocSummary[]> {
    const userNames = await walkMarkdown(this.root);
    const sharedNames = (await walkMarkdown(sharedDir())).map((name) => `shared/${name}`);
    const summaries: DocSummary[] = [];
    for (const name of [...userNames, ...sharedNames]) {
      const { file, scope } = this.locate(name);
      const content = await fs.readFile(file, "utf8");
      summaries.push({ name, scope, title: titleOf(content, name), bytes: Buffer.byteLength(content) });
    }
    return summaries;
  }

  async read(name: string): Promise<{ name: string; scope: DocScope; content: string }> {
    const located = this.locate(name);
    try {
      const content = await fs.readFile(located.file, "utf8");
      return { name: located.name, scope: located.scope, content };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`No document named "${located.name}". Call list_documents to see what exists.`);
      }
      throw error;
    }
  }

  /** Case-insensitive line search. Lines matching every term rank first, then lines matching any term. */
  async search(query: string, limit = 20): Promise<SearchHit[]> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const all: SearchHit[] = [];
    const some: SearchHit[] = [];
    for (const doc of await this.list()) {
      const { content } = await this.read(doc.name);
      content.split("\n").forEach((text, index) => {
        const lower = text.toLowerCase();
        const matched = terms.filter((term) => lower.includes(term)).length;
        if (matched === 0) return;
        const hit = { name: doc.name, line: index + 1, text: text.trim() };
        (matched === terms.length ? all : some).push(hit);
      });
    }
    return [...all, ...some].slice(0, limit);
  }

  async write(name: string, content: string): Promise<{ name: string; bytes: number }> {
    const located = this.locate(name);
    if (located.scope === "shared") throw new Error("Shared reference documents are read-only.");
    await fs.mkdir(path.dirname(located.file), { recursive: true });
    await fs.writeFile(located.file, content.endsWith("\n") ? content : `${content}\n`, "utf8");
    return { name: located.name, bytes: Buffer.byteLength(content) };
  }

  /** Append a dated line to notes.md, the agent's running memory about this household. */
  async appendNote(note: string, at = new Date()): Promise<{ name: string }> {
    const { file } = this.locate("notes.md");
    await fs.mkdir(path.dirname(file), { recursive: true });
    let existing = "";
    try {
      existing = await fs.readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const header = existing ? "" : "# Notes\n\nThings the copilot learned from the household, newest last.\n\n";
    const line = `- ${at.toISOString().slice(0, 16).replace("T", " ")} — ${note.trim().replace(/\s*\n\s*/g, " ")}\n`;
    await fs.writeFile(file, `${existing}${header}${line}`, "utf8");
    return { name: "notes.md" };
  }
}

export type Household = {
  name: string;
  firstName: string;
  phone: string;
  language: string;
  profile: string;
};

function field(profile: string, label: string): string | undefined {
  const match = profile.match(new RegExp(`^-\\s*${label}:\\s*(.+)$`, "im"));
  return match?.[1].trim();
}

/** Reads profile.md for the household's contact details. */
export async function loadHousehold(kb: KnowledgeBase): Promise<Household> {
  const { content } = await kb.read("profile.md");
  const name = field(content, "Name") ?? kb.userId;
  // DEMO_PHONE routes every household's texts to one real number for demos,
  // so personal numbers never need to be written into tracked seed files.
  const phone = process.env.DEMO_PHONE?.trim() || field(content, "Phone");
  if (!phone) throw new Error(`profile.md for ${kb.userId} needs a "- Phone:" line`);
  return {
    name,
    firstName: name.split(/\s+/)[0],
    phone: phone.replace(/[^\d+]/g, ""),
    language: field(content, "Preferred language") ?? "English",
    profile: content,
  };
}

/**
 * Find the household whose profile lists this phone number (used for inbound SMS webhooks).
 * Compares digits only, since providers send numbers with or without a leading "+".
 */
export async function findUserByPhone(phone: string): Promise<string | undefined> {
  const digits = (value: string) => value.replace(/\D/g, "");
  const wanted = digits(phone);
  let entries: string[] = [];
  try {
    entries = await fs.readdir(usersDir());
  } catch {
    return undefined;
  }
  for (const userId of entries) {
    try {
      const household = await loadHousehold(new KnowledgeBase(userId));
      if (digits(household.phone) === wanted) return userId;
    } catch {
      // not a household folder
    }
  }
  return undefined;
}
