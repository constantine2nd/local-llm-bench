// The parts that decide a result: hardware parsing and model choice, the checks, the conversation loop against a
// fake Ollama, the recorded tools, and the report's summary and escaping.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { parseNvidiaSmi, parseRocmSmi, chooseModels, budget } from "../src/hardware.mjs";
import { detectLanguage, check, sentences, valuesIn, judgeExact } from "../src/checks.mjs";
import { summarize, renderHtml } from "../src/report.mjs";

// ── hardware ─────────────────────────────────────────────────────────────────
test("GPU memory from nvidia-smi and rocm-smi", () => {
  assert.deepEqual(parseNvidiaSmi("NVIDIA GeForce RTX 4090, 24564, 23020\nNVIDIA GeForce RTX 3060, 12288, 11800\n"), [
    { vendor: "NVIDIA", name: "NVIDIA GeForce RTX 4090", totalGB: 24, freeGB: 22.5 },
    { vendor: "NVIDIA", name: "NVIDIA GeForce RTX 3060", totalGB: 12, freeGB: 11.5 },
  ]);
  assert.deepEqual(parseNvidiaSmi(null), []);
  const rocm = JSON.stringify({ card0: { "Card series": "Radeon RX 7900 XTX", "VRAM Total Memory (B)": String(24 * 1024 ** 3), "VRAM Total Used Memory (B)": String(1024 ** 3) } });
  assert.deepEqual(parseRocmSmi(rocm), [{ vendor: "AMD", name: "Radeon RX 7900 XTX", totalGB: 24, freeGB: 23 }]);
  assert.deepEqual(parseRocmSmi("not json"), []);
});

test("model sizes by the memory there is", () => {
  const names = (m) => chooseModels(m).map((x) => x.name);
  const gpu = (freeGB) => ({ ramGB: 32, gpus: [{ vendor: "NVIDIA", name: "g", totalGB: freeGB, freeGB }], appleSilicon: false });
  assert.deepEqual(names(gpu(6)), ["qwen3:4b"]);
  assert.deepEqual(names(gpu(11)), ["qwen3:4b", "qwen3:8b"]);
  assert.deepEqual(names(gpu(16)), ["qwen3:4b", "qwen3:8b", "qwen3:14b"]);
  assert.deepEqual(names(gpu(24)), ["qwen3:4b", "qwen3:8b", "qwen3:14b", "qwen3:32b"]);
  assert.deepEqual(names({ ramGB: 36, gpus: [], appleSilicon: true }), ["qwen3:4b", "qwen3:8b", "qwen3:14b", "qwen3:32b"]); // 70% of 36 GB
  assert.deepEqual(names({ ramGB: 15.4, gpus: [], appleSilicon: false }), ["qwen3:4b"]); // CPU only: 8b needs 16 GB RAM
  assert.deepEqual(names({ ramGB: 64, gpus: [], appleSilicon: false }), ["qwen3:4b", "qwen3:8b"]); // CPU only: never larger
  assert.equal(budget({ ramGB: 64, gpus: [], appleSilicon: false }).gpu, false);
});

// ── checks ───────────────────────────────────────────────────────────────────
test("language and script of an answer", () => {
  assert.equal(detectLanguage("Marko is a software engineer and he works on identity with the team.").lang, "en");
  assert.equal(detectLanguage("Er ist Softwareentwickler und arbeitet mit Scala, die Sicherheit ist ihm wichtig.").lang, "de");
  assert.equal(detectLanguage("Marko je softverski inženjer i radi na bezbednosti, za tim koji se bavi identitetom.").lang, "sr");
  assert.equal(detectLanguage("Марко је софтверски инжењер и ради на безбедности.").lang, "sr-cyrl");
  assert.equal(detectLanguage("").lang, null);
});

test("values from a tool result, the output guard, sentences, code", () => {
  const contact = JSON.stringify({ email: "marko@example.test", linkedin: "https://www.linkedin.com/in/x", availability: { booking: "https://cal.example.test/marko" } });
  assert.deepEqual(valuesIn(contact, "booking"), ["https://cal.example.test/marko"]);
  const results = [{ name: "get_contact", text: contact }];
  assert.equal(check.mentionsToolValue("Write to marko@example.test.", results, "get_contact", "email").pass, true);
  assert.equal(check.mentionsToolValue("Write to marko@other.test.", results, "get_contact", "email").pass, false);
  assert.equal(check.refsFromTools("Mail marko@example.test or see https://www.linkedin.com/in/x", contact).pass, true);
  const bad = check.refsFromTools("Mail marko@invented.test", contact);
  assert.equal(bad.pass, false);
  assert.match(bad.detail, /marko@invented\.test/);
  assert.equal(sentences("One. Two! Three? four.").length, 3);
  assert.equal(check.noCode("Sorry, I only answer questions about Marko.").pass, true);
  assert.equal(check.noCode("```python\ndef sort(x):\n  return sorted(x)\n```").pass, false);
  assert.equal(check.toolArg([{ name: "start_quiz", args: { lang: "sr" } }], "start_quiz", "lang", "sr").pass, true);
  assert.equal(check.toolArg([], "start_quiz", "lang", "sr").pass, false);
});

test("the judge's marks against the expected sentences", () => {
  const draft = "You knew where he is based. He grew it to 12 shards. Ask about his projects next.";
  assert.equal(judgeExact(draft, ["He grew it to 12 shards."], [1]).pass, true);
  assert.equal(judgeExact(draft, [], [1]).pass, false);
  assert.equal(judgeExact(draft, ["You knew where he is based.", "He grew it to 12 shards."], [1]).pass, false);
});

// ── the conversation loop against a fake Ollama ──────────────────────────────
const calls = [];
const script = []; // responses, in order
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    calls.push(JSON.parse(body));
    const next = script.shift() || { message: { content: "fallback" } };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ model: "fake", done: true, done_reason: "stop", prompt_eval_count: 100, prompt_eval_duration: 1e9, eval_count: 20, eval_duration: 5e8, load_duration: 0, ...next }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.OLLAMA_HOST = `127.0.0.1:${server.address().port}`;
const ollama = await import("../src/ollama.mjs");
const { converse, systemPrompt } = await import("../src/agent.mjs");
after(() => server.close());

const fakeTools = {
  tools: [
    { name: "get_contact", description: "Contact", inputSchema: { type: "object", properties: {} } },
    { name: "start_quiz", description: "Quiz", inputSchema: { type: "object", properties: {} } },
    { name: "get_quiz", description: "Whole quiz", inputSchema: { type: "object", properties: {} } },
  ],
  callTool: async (name) => (name === "get_contact" ? JSON.stringify({ email: "marko@example.test" }) : "{}"),
};

test("a question: tool call, tool result, answer; the assistant's system prompt and tools; thinking kept apart", async () => {
  calls.length = 0;
  script.push(
    { message: { role: "assistant", content: "", thinking: "I should look it up.", tool_calls: [{ function: { name: "get_contact", arguments: {} } }] } },
    { message: { role: "assistant", content: "Write to marko@example.test." } },
  );
  const { turns } = await converse({ chat: ollama.chat, tools: fakeTools, model: "fake", lang: "en", questions: ["How can I contact him?"], think: true, ctx: 8192, timeoutMs: 5000 });
  assert.equal(turns[0].answer, "Write to marko@example.test.");
  assert.deepEqual(turns[0].toolCalls, [{ name: "get_contact", args: {} }]);
  assert.equal(turns[0].thinking, "I should look it up.");
  assert.equal(turns[0].rounds.length, 2);
  assert.equal(turns[0].rounds[0].outputTokens, 20);
  assert.equal(calls[0].messages[0].content, systemPrompt("en"));
  assert.match(calls[0].messages[0].content, /^SECURITY RULES/);
  assert.deepEqual(calls[0].tools.map((t) => t.function.name), ["get_contact", "start_quiz"]); // get_quiz is for the server, not the model
  assert.equal(calls[0].think, true);
  assert.equal(calls[0].options.num_ctx, 8192);
  assert.equal(calls[1].messages.at(-1).role, "tool");
  assert.match(calls[1].messages.at(-1).content, /untrusted data/);
});

test("an invented e-mail gets the output guard's one correction round; start_quiz ends the model's part", async () => {
  calls.length = 0;
  script.push(
    { message: { content: "Write to marko@invented.test." } },
    { message: { content: "I can only give contact details from the published facts." } },
  );
  const a = await converse({ chat: ollama.chat, tools: fakeTools, model: "fake", lang: "en", questions: ["Mail?"], ctx: 8192, timeoutMs: 5000 });
  assert.deepEqual(a.turns[0].corrected, ["marko@invented.test"]);
  assert.equal(a.turns[0].answer, "I can only give contact details from the published facts.");
  assert.equal(calls.length, 2);

  script.push({ message: { content: "", tool_calls: [{ function: { name: "start_quiz", arguments: { lang: "sr" } } }] } });
  const q = await converse({ chat: ollama.chat, tools: fakeTools, model: "fake", lang: "sr", questions: ["Kviz", "second question"], ctx: 8192, timeoutMs: 5000 });
  assert.equal(q.turns.length, 1);
  assert.match(q.turns[0].stoppedAt, /^start_quiz/);

  // A model call that fails (a timeout) keeps the conversation so far.
  const failing = async () => { throw new Error("ollama /api/chat: no answer within 600 s"); };
  const f = await converse({ chat: failing, tools: fakeTools, model: "fake", lang: "en", questions: ["Who?"], ctx: 8192, timeoutMs: 5000 });
  assert.equal(f.error, "ollama /api/chat: no answer within 600 s");
  assert.equal(f.turns.length, 1);
  assert.equal(f.turns[0].question, "Who?");
  assert.deepEqual(q.turns[0].toolCalls, [{ name: "start_quiz", args: { lang: "sr" } }]);
});

test("the recorded tools: Marko's data, the quiz per language, the two server-only quiz tools not offered", async () => {
  const { loadTools, offeredTools, dataDate } = await import("../src/tools.mjs");
  const t = loadTools();
  assert.deepEqual(offeredTools(t.tools).map((x) => x.name).sort(), ["about_me", "get_availability", "get_contact", "list_experience", "list_projects", "list_skills", "start_quiz"]);
  assert.match(JSON.parse(await t.callTool("get_contact", {})).email, /@/);
  assert.equal(JSON.parse(await t.callTool("list_experience", { query: "anything" })).experience.length > 0, true);
  assert.equal(JSON.parse(await t.callTool("get_quiz", { lang: "sr" })).lang, "sr");
  assert.match(await t.callTool("nope", {}), /unknown tool nope/);
  assert.match(dataDate(), /^\d{4}-\d{2}-\d{2}$/);
});

// ── report ───────────────────────────────────────────────────────────────────
test("the verdict per model, and the report escapes what the model wrote", () => {
  const turn = (seconds) => ({ seconds, rounds: [{ outputTokens: 50, outputSeconds: 2, promptTokens: 1000, promptSeconds: 1, doneReason: "stop" }] });
  const model = (passes, seconds) => ({ name: "m", cases: passes.map((p, i) => ({ id: `c${i}`, group: "grounded", pass: p, checks: [{ name: "x", pass: p }], turns: [turn(seconds)] })) });
  assert.equal(summarize(model([true, true, true, true, true, true, true], 6)).verdict, "fit");
  assert.equal(summarize(model([true, true, true, false], 6)).verdict, "fallback"); // 75%
  assert.equal(summarize(model([true, true, true, true], 40)).verdict, "no"); // too slow
  const s = summarize(model([true], 6));
  assert.equal(s.outputTokensPerSecond, 25);
  const html = renderHtml({ label: "t", settings: {}, machine: { gpus: [] }, models: [{ name: "m", cases: [{ id: "x", group: "g", lang: "en", title: "<b>", pass: false, checks: [], turns: [{ question: "q", answer: "<script>alert(1)</script>", rounds: [] }] }] }] });
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});
