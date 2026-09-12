/**
 * No-API-key smoke test. Exercises the knowledge base, message log, file session, the
 * text-message guardrail, and the full agent loop driven by a scripted fake model.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function main(): Promise<void> {
  process.env.OPENAI_AGENTS_DISABLE_TRACING = "1";
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "snap-copilot-"));
  await fs.cp(path.join(process.cwd(), "data"), tmp, {
    recursive: true,
    // seed documents only: leave behind any runtime state from a live run
    filter: (source) => !/(?:messages\.jsonl|session\.json(?:\..*)?|notes\.md)$/.test(source),
  });
  process.env.DATA_DIR = tmp;

  const { Usage } = await import("@openai/agents");
  type Agents = typeof import("@openai/agents");
  type Model = Agents["Agent"]["prototype"]["model"] extends infer M ? Exclude<M, string> : never;
  type ModelRequest = Parameters<Model["getResponse"]>[0];
  type ModelResponse = Awaited<ReturnType<Model["getResponse"]>>;
  type OutputItem = ModelResponse["output"][number];

  const { KnowledgeBase, loadHousehold } = await import("../src/lib/kb");
  const { MessageLog, ConsoleSms } = await import("../src/lib/sms");
  const { FileSession } = await import("../src/lib/session");
  const { householdTextGuardrail, runTurn } = await import("../src/lib/agent");

  const userId = "maria-demo";
  let passed = 0;
  const check = (label: string, fn: () => void | Promise<void>) =>
    Promise.resolve()
      .then(fn)
      .then(() => {
        passed += 1;
        console.log(`  ✓ ${label}`);
      });

  console.log("knowledge base");
  const kb = new KnowledgeBase(userId);
  await check("lists household and shared docs", async () => {
    const names = (await kb.list()).map((d) => d.name);
    assert.ok(names.includes("case.md"));
    assert.ok(names.includes("notices/2026-09-recert-packet.md"));
    assert.ok(names.includes("shared/snap-basics.md"));
    assert.ok(!names.some((n) => n.endsWith("messages.jsonl")));
  });
  await check("reads a doc and parses the household profile", async () => {
    assert.match((await kb.read("case.md")).content, /Recertification interview: 2026-10-06/);
    const household = await loadHousehold(kb);
    assert.equal(household.firstName, "Maria");
    assert.equal(household.phone, "+15550100199");
  });
  await check("search ranks lines matching every term first", async () => {
    const hits = await kb.search("interview 10:30");
    assert.ok(hits.length > 0);
    assert.match(hits[0].text, /10:30/);
  });
  await check("writes a household doc and appends notes", async () => {
    await kb.write("documents.md", "# Checklist\n\n| Document | Status |\n|---|---|\n| Pay stubs | Received |");
    assert.match((await kb.read("documents.md")).content, /Received/);
    await kb.appendNote("First note");
    await kb.appendNote("Second\nnote");
    const notes = (await kb.read("notes.md")).content;
    assert.equal(notes.match(/^# Notes/gm)?.length, 1);
    assert.match(notes, /First note\n.*Second note/);
  });
  await check("refuses shared writes and path escapes", async () => {
    await assert.rejects(kb.write("shared/snap-basics.md", "x"), /read-only/);
    await assert.rejects(kb.read("../../etc/passwd"), /Invalid document name/);
    await assert.rejects(kb.read("nope.md"), /No document named/);
  });

  console.log("message log and session");
  await check("message log appends and reads back", async () => {
    const log = new MessageLog(userId);
    await log.append({ direction: "inbound", phone: "+15550100199", body: "hi", channel: "test" });
    const all = await log.all();
    assert.equal(all.length, 1);
    assert.equal(all[0].body, "hi");
    await fs.rm(log.file);
  });
  await check("file session stores, limits, pops, clears", async () => {
    const session = new FileSession(userId);
    await session.addItems([{ type: "message", role: "user", content: "a" }, { type: "message", role: "user", content: "b" }]);
    assert.equal((await session.getItems()).length, 2);
    assert.equal((await session.getItems(1)).length, 1);
    const popped = await session.popItem();
    assert.equal((popped as { content: string }).content, "b");
    await session.clearSession();
    assert.equal((await session.getItems()).length, 0);
  });

  console.log("text-message guardrail");
  const verdict = async (body: string) =>
    (
      await householdTextGuardrail.run({
        context: {} as never,
        agent: {} as never,
        toolCall: { type: "function_call", callId: "c1", name: "send_text_message", arguments: JSON.stringify({ body }) },
      })
    ).behavior.type;
  await check("allows a plain next-step text", async () => assert.equal(await verdict("Hi Maria, your SNAP interview is Oct 6 at 10:30am."), "allow"));
  await check("blocks dollar amounts", async () => assert.equal(await verdict("You will get $291 a month."), "rejectContent"));
  await check("blocks eligibility verdicts", async () => assert.equal(await verdict("Good news, you are eligible!"), "rejectContent"));
  await check("blocks credential asks", async () => assert.equal(await verdict("Reply with your EBT card number to continue."), "rejectContent"));
  await check("blocks over-long texts", async () => assert.equal(await verdict("x".repeat(481)), "rejectContent"));

  console.log("agent loop with a scripted model");
  const call = (name: string, args: Record<string, unknown>, id: string): OutputItem => ({
    type: "function_call",
    callId: id,
    name,
    arguments: JSON.stringify(args),
    status: "completed",
  });
  const say = (text: string): OutputItem => ({
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text }],
  });

  class ScriptedModel implements Model {
    readonly requests: ModelRequest[] = [];
    constructor(private readonly steps: OutputItem[][]) {}
    async getResponse(request: ModelRequest): Promise<ModelResponse> {
      this.requests.push(request);
      const output = this.steps.shift();
      if (!output) throw new Error("scripted model ran out of steps");
      return { usage: new Usage(), output };
    }
    async *getStreamedResponse(): AsyncIterable<never> {
      throw new Error("streaming is not scripted");
    }
  }

  const resultText = (request: ModelRequest, callId: string) => {
    const items = Array.isArray(request.input) ? request.input : [];
    const item = items.find((i) => i.type === "function_call_result" && i.callId === callId) as { output?: unknown } | undefined;
    return JSON.stringify(item?.output ?? "");
  };

  const model = new ScriptedModel([
    [call("read_document", { name: "case.md" }, "c1")],
    [call("send_text_message", { body: "Maria, HRA will pay you $291 next month." }, "c2")],
    [call("send_text_message", { body: "Hi Maria, it's your SNAP copilot. Your recert interview is Oct 6 at 10:30am. Step 1: submit the recert form in ACCESS HRA before then. Want help?" }, "c3")],
    [call("save_note", { note: "Sent first recert nudge." }, "c4")],
    [say("Sent Maria the first nudge; waiting on her reply.")],
  ]);

  const first = await runTurn(userId, { kind: "event", name: "renewal_sweep", detail: "test sweep" }, { model, transport: new ConsoleSms(true) });
  await check("system prompt carries the household profile and today's date", () => {
    assert.match(String(model.requests[0].systemInstructions), /Maria Alvarez/);
    assert.match(String(model.requests[0].systemInstructions), /Today is/);
  });
  await check("tool results flow back: case.md content reached the model", () => {
    assert.match(resultText(model.requests[1], "c1"), /2026-10-06/);
  });
  await check("guardrail rejection is what the model sees for the dollar text", () => {
    assert.match(resultText(model.requests[2], "c2"), /Blocked: do not quote dollar amounts/);
  });
  await check("only the clean text was sent and logged", async () => {
    assert.equal(first.sent.length, 1);
    assert.match(first.sent[0].body, /Oct 6/);
    const logged = await new MessageLog(userId).all();
    assert.equal(logged.length, 1);
    assert.equal(logged[0].direction, "outbound");
  });
  await check("note was written and summary returned", async () => {
    assert.match((await kb.read("notes.md")).content, /Sent first recert nudge/);
    assert.equal(first.summary, "Sent Maria the first nudge; waiting on her reply.");
    assert.deepEqual(first.toolCalls, ["read_document", "send_text_message", "send_text_message", "save_note"]);
  });

  const model2 = new ScriptedModel([[say("Acknowledged; nothing to send.")]]);
  const second = await runTurn(userId, { kind: "inbound_text", body: "ok I will do it tonight" }, { model: model2, transport: new ConsoleSms(true) });
  await check("second turn replays the persisted session history", () => {
    const items = Array.isArray(model2.requests[0].input) ? model2.requests[0].input : [];
    assert.ok(items.some((i) => i.type === "function_call" && (i as { name?: string }).name === "read_document"));
    assert.ok(items.some((i) => i.type === "message" && JSON.stringify(i).includes("ok I will do it tonight")));
    assert.equal(second.sent.length, 0);
  });
  await check("inbound text was logged before the run", async () => {
    const logged = await new MessageLog(userId).all();
    assert.equal(logged.length, 2);
    assert.equal(logged[1].direction, "inbound");
  });

  await fs.rm(tmp, { recursive: true, force: true });
  console.log(`\n${passed} checks passed`);
}

main().catch((error) => {
  console.error("\n✖ smoke test failed:", error);
  process.exit(1);
});
