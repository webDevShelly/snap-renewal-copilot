"use client";

import { useState } from "react";

type AgentAction = { type: string; document?: { label: string; dueDate?: string }; uploadUrl?: string; draftId?: string };

export default function Home() {
  const [action, setAction] = useState<AgentAction | null>(null);
  const [loading, setLoading] = useState(false);
  const [callStatus, setCallStatus] = useState<"idle" | "holding" | "connected">("idle");

  async function runAgent() {
    setLoading(true);
    const response = await fetch("/api/agent/run", { method: "POST" });
    setAction(await response.json());
    setLoading(false);
  }

  function startMockCall() {
    setCallStatus("holding");
    window.setTimeout(() => setCallStatus("connected"), 3500);
  }

  return <main>
    <p className="eyebrow">SNAP Renewal Copilot · demo</p>
    <h1>Keep a SNAP renewal from falling through the cracks.</h1>
    <p className="lede">Maria’s benefits end November 15. Her renewal is due October 31, and the agent has already identified the next step.</p>
    <section className="card">
      <div><span>Renewal status</span><strong>Action required</strong></div>
      <div><span>Time remaining</span><strong>45 days</strong></div>
      <div><span>Missing item</span><strong>Recent pay stub</strong></div>
    </section>
    <button onClick={runAgent} disabled={loading}>{loading ? "Checking portal…" : "Run renewal agent"}</button>
    {action && <section className="result">
      <h2>Agent action</h2>
      {action.type === "SEND_DOCUMENT_REQUEST" && <p>Request <b>{action.document?.label}</b> by {action.document?.dueDate}. Demo upload link: <code>{action.uploadUrl}</code></p>}
      {action.type === "CREATE_RENEWAL_DRAFT" && <p>Created a renewal draft: <code>{action.draftId}</code></p>}
    </section>}
    <section className="call-card">
      <p className="eyebrow">Mock support-line experience</p>
      <h2>Don’t lose hours waiting for renewal help.</h2>
      <p>The demo agent calls the user-authorized mock SNAP support number <b>404-360-5104</b>, stays on hold, and gathers the renewal context before a representative connects.</p>
      {callStatus === "idle" && <button onClick={startMockCall}>Simulate SNAP support call</button>}
      {callStatus === "holding" && <p className="call-status">On hold · Agent is collecting Maria’s renewal status and missing-document details…</p>}
      {callStatus === "connected" && <p className="call-status connected">Representative connected · Agent is ready with a concise renewal summary.</p>}
    </section>
    <p className="fine-print">The demo never submits a renewal automatically. Final submission requires the household’s explicit confirmation.</p>
  </main>;
}
