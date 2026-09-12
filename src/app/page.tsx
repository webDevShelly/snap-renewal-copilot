"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

type Message = { id: string; at: string; direction: "inbound" | "outbound"; body: string };
type Doc = { name: string; scope: "user" | "shared"; title: string; content: string };
type Thread = {
  household: { name: string; firstName: string; phone: string };
  messages: Message[];
  documents: Doc[];
};

const time = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export default function Home() {
  const [thread, setThread] = useState<Thread | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<null | "send" | "sweep">(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/thread");
    const data = await response.json();
    if (response.ok) setThread(data);
    else setError(data.error ?? "Could not load the thread");
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function act(payload: Record<string, string>, mode: "send" | "sweep") {
    setBusy(mode);
    setError(null);
    try {
      const response = await fetch("/api/agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "The agent run failed");
      setNote(data.summary || "(the agent left no internal note)");
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(null);
      await refresh();
    }
  }

  function send(event: FormEvent) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || busy) return;
    setDraft("");
    act({ message }, "send");
  }

  const first = thread?.household.firstName ?? "the household";

  return (
    <main>
      <p className="eyebrow">SNAP Renewal Copilot · demo</p>
      <h1>An agent that texts, remembers, and never submits.</h1>
      <p className="lede">
        The copilot reads {first}&rsquo;s local knowledge base, texts the one next step that keeps her SNAP from lapsing, and writes
        what it learns back to her file. Play {first} on the left; watch her file on the right.
      </p>

      <div className="layout">
        <section className="phone">
          <header>
            <strong>{thread?.household.name ?? "…"}</strong>
            <span>{thread?.household.phone}</span>
          </header>
          <div className="thread">
            {thread?.messages.length === 0 && <p className="empty">No texts yet. Run the renewal sweep to let the agent make first contact.</p>}
            {thread?.messages.map((message) => (
              <div
                key={message.id}
                className={`bubble ${message.direction === "outbound" ? "out" : "in"}${message.body.startsWith("[call") ? " call" : ""}`}
              >
                <p>{message.body.startsWith("[call") ? `📞 ${message.body.replace(/^\[call( to SNAP)?\] /, (_m, snap) => (snap ? "To SNAP: " : ""))}` : message.body}</p>
                <time>{time(message.at)}</time>
              </div>
            ))}
            {busy && <p className="typing">Copilot is {busy === "sweep" ? "running the sweep" : "thinking"}…</p>}
          </div>
          <form onSubmit={send}>
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={`Reply as ${first}…`}
              disabled={busy !== null}
              aria-label={`Reply as ${first}`}
            />
            <button type="submit" disabled={busy !== null || !draft.trim()}>
              Send
            </button>
          </form>
          <button className="secondary" onClick={() => act({ event: "renewal_sweep" }, "sweep")} disabled={busy !== null}>
            Run renewal sweep
          </button>
          {note && (
            <p className="note">
              <span>Agent&rsquo;s internal note</span>
              {note}
            </p>
          )}
          {error && <p className="error">{error}</p>}
        </section>

        <aside className="kb">
          <h2>Knowledge base</h2>
          <p className="hint">Plain markdown files on disk. The agent reads them with tools and edits them when {first} tells it something new.</p>
          {thread?.documents.map((doc) => (
            <details key={doc.name} open={doc.name === "notes.md"}>
              <summary>
                {doc.title}
                <code>{doc.name}</code>
              </summary>
              <pre>{doc.content}</pre>
            </details>
          ))}
        </aside>
      </div>

      <p className="fine-print">
        Demo data only. The copilot never submits a recertification, never states eligibility, never quotes a benefit amount, and never
        asks for credentials. Those rules are enforced by a guardrail on the text and call tools, not just by the prompt.
      </p>
    </main>
  );
}
