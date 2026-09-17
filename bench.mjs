#!/usr/bin/env node
// local-llm-bench: run Marko's assistant scenarios on local Ollama models and write a report. See README.md.
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import * as ollama from "./src/ollama.mjs";
import { detect, budget, chooseModels, freeDiskGB, MODELS } from "./src/hardware.mjs";
import { loadTools, dataDate } from "./src/tools.mjs";
import { SCENARIOS } from "./src/scenarios.mjs";
import { renderHtml, summarize } from "./src/report.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const DATA_DATE = dataDate();

const HELP = `local-llm-bench ${VERSION}: Marko's assistant scenarios on local Ollama models

  ./run.sh [options]            (Windows: run.cmd [options]; or: node bench.mjs [options])

  --quick              the short set (${SCENARIOS.filter((s) => s.quick).length} of ${SCENARIOS.length} cases)
  --models a,b         test these models instead of choosing by memory (e.g. qwen3:8b,qwen3:14b)
  --cases a,b          only these case ids (see --list)
  --no-think           ask thinking models not to think (qwen3 4b may think anyway; the report shows it)
  --ctx N              context window in tokens (default 16384)
  --timeout S          seconds one model call may take (default 600 without a GPU, 120 with one)
  --yes                download models without asking
  --label NAME         name in the report and archive (default: the host name)
  --resume DIR         continue an interrupted run (a folder in reports/)
  --list               show the machine, the chosen models and the cases, then stop
  --help`;

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
if (flag("help")) { console.log(HELP); process.exit(0); }

const log = (s = "") => console.log(s);
const fail = (s) => { console.error(`\n✗ ${s}\n`); process.exit(1); };
const [major] = process.versions.node.split(".").map(Number);
if (major < 20) fail(`Node ${process.versions.node} is too old: install Node 20 or newer (https://nodejs.org).`);

// ── machine, Ollama, models ──────────────────────────────────────────────────
log(`local-llm-bench ${VERSION} · scenarios of Marko's AI assistant (facts recorded ${DATA_DATE})\n`);
const machine = detect();
const b = budget(machine);
log(`Machine   ${machine.os}\n          ${machine.cpu}, ${machine.cores} threads, ${machine.ramGB} GB RAM`);
log(`GPU       ${machine.gpus.length ? machine.gpus.map((g) => `${g.vendor} ${g.name}, ${g.totalGB} GB (${g.freeGB} GB free)`).join("; ") : machine.appleSilicon ? "Apple Silicon, unified memory" : "none found: models run on the CPU (slow)"}`);
log(`Memory    ${b.gb} GB for models (${b.where})`);

let ollamaVersion;
try { ollamaVersion = await ollama.version(); } catch {
  const install = process.platform === "win32" ? "download it from https://ollama.com/download/windows" : process.platform === "darwin" ? "download it from https://ollama.com/download/mac, or: brew install ollama" : "curl -fsSL https://ollama.com/install.sh | sh";
  fail(`Ollama is not reachable at ${ollama.OLLAMA_URL}.\n  Install it: ${install}\n  Then start it (the app, or: ollama serve) and run this again. Another address: OLLAMA_HOST=host:port`);
}
log(`Ollama    ${ollamaVersion} at ${ollama.OLLAMA_URL}`);

const models = opt("models") ? opt("models").split(",").map((s) => s.trim()).filter(Boolean) : chooseModels(machine).map((m) => m.name);
const have = new Set((await ollama.installed()).map((m) => m.name));
const missing = models.filter((m) => !have.has(m));
const downloadGB = missing.reduce((sum, m) => sum + (MODELS.find((x) => x.name === m)?.downloadGB || 0), 0);
log(`Models    ${models.map((m) => `${m}${have.has(m) ? "" : " (to download)"}`).join(", ")}`);
if (!opt("models") && models.length < MODELS.length) log(`          not tested here: ${MODELS.filter((m) => !models.includes(m.name)).map((m) => `${m.name} (needs ~${m.needsGB} GB)`).join(", ")}`);

const selected = SCENARIOS.filter((s) => (opt("cases") ? opt("cases").split(",").includes(s.id) : flag("quick") ? s.quick : true));
const settings = { quick: flag("quick"), think: flag("no-think") ? false : undefined, ctx: Number(opt("ctx") || 16384), timeoutSeconds: Number(opt("timeout") || (b.gpu ? 120 : 600)) };
log(`Cases     ${selected.length}: ${selected.map((s) => s.id).join(", ")}`);
log(`Settings  context ${settings.ctx} tokens · up to ${settings.timeoutSeconds} s per model call · thinking ${settings.think === false ? "off" : "on"}`);
if (flag("list")) process.exit(0);

if (missing.length) {
  const disk = freeDiskGB();
  log(`\nTo download: ${missing.join(", ")} · about ${downloadGB.toFixed(1)} GB${disk != null ? ` (${disk} GB free on disk)` : ""}`);
  if (disk != null && disk < downloadGB + 2) fail(`Not enough free disk space for the downloads. Free some space, or choose smaller models with --models.`);
  if (!flag("yes")) {
    if (!process.stdin.isTTY) fail("Downloads need a confirmation: run in a terminal, or add --yes.");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("Download now? [y/N] ")).trim().toLowerCase();
    rl.close();
    if (answer !== "y" && answer !== "yes") fail("Nothing downloaded. Run again with the models you have: --models <name>.");
  }
}

const tools = loadTools();

// ── results, resumable ───────────────────────────────────────────────────────
const label = (opt("label") || (await import("node:os")).hostname()).replace(/[^\w.-]+/g, "-");
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
const dir = opt("resume") ? path.resolve(opt("resume")) : path.join(ROOT, "reports", `${stamp}-${label}`);
mkdirSync(dir, { recursive: true });
const resultsFile = path.join(dir, "results.json");
const results = existsSync(resultsFile) ? JSON.parse(readFileSync(resultsFile, "utf8")) : {
  tool: "local-llm-bench", version: VERSION, dataDate: DATA_DATE, label, startedAt: new Date().toISOString(), finishedAt: null,
  machine, ollama: { version: ollamaVersion, url: ollama.OLLAMA_URL }, settings, models: [],
};
const save = () => {
  writeFileSync(resultsFile, JSON.stringify(results, null, 2));
  writeFileSync(path.join(dir, "report.html"), renderHtml(results));
};

const fmt = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${s.toFixed(1)}s`);
const started = Date.now();

for (const name of models) {
  let entry = results.models.find((m) => m.name === name);
  if (!entry) { entry = { name, cases: [] }; results.models.push(entry); }
  log(`\n── ${name}`);
  try {
    if (!have.has(name)) {
      let last = 0;
      await ollama.pull(name, (done, total, status) => {
        if (Date.now() - last < 1000 && done !== total) return;
        last = Date.now();
        process.stdout.write(`\r   downloading: ${total ? `${(done / 1024 ** 3).toFixed(2)} / ${(total / 1024 ** 3).toFixed(2)} GB` : status}      `);
      });
      process.stdout.write("\n");
    }
    const info = await ollama.show(name);
    entry.capabilities = info.capabilities || [];
    if (!entry.capabilities.includes("tools")) throw new Error(`${name} does not support tool calls, which the assistant needs`);
    const think = settings.think === false ? false : entry.capabilities.includes("thinking") ? true : undefined;
    // Load it once, so the first case does not carry the loading time.
    const warm = await ollama.chat({ model: name, system: "Reply with: ok", messages: [{ role: "user", content: "ok?" }], think, ctx: settings.ctx, timeoutMs: 600000 });
    entry.loadSeconds = warm.stats.loadSeconds;
    const ps = (await ollama.loaded()).find((m) => m.name === name || m.model === name);
    entry.memory = ps ? { size: ps.size, sizeVram: ps.size_vram } : null;
    log(`   loaded in ${fmt(warm.stats.loadSeconds)} · ${ps ? `${(ps.size / 1024 ** 3).toFixed(1)} GB, ${Math.round((100 * ps.size_vram) / ps.size)}% on GPU` : "memory not reported"}`);
    save();

    for (const [i, sc] of selected.entries()) {
      if (entry.cases.find((c) => c.id === sc.id && !c.error)) { log(`   ${i + 1}/${selected.length} ${sc.id}: done earlier`); continue; }
      entry.cases = entry.cases.filter((c) => c.id !== sc.id);
      const caseStarted = Date.now();
      const line = (extra) => process.stdout.write(`\r   ${i + 1}/${selected.length} ${sc.id.padEnd(18)} ${extra}`.padEnd(100));
      line("…");
      const record = { id: sc.id, group: sc.group, lang: sc.lang, title: sc.title };
      try {
        const out = await sc.run({ chat: ollama.chat, tools, model: name, think, ctx: settings.ctx, timeoutMs: settings.timeoutSeconds * 1000,
          onRound: (n, st) => line(`model call ${n} · ${st.outputTokens} tokens in ${fmt(st.seconds)} · ${fmt((Date.now() - caseStarted) / 1000)}`) });
        Object.assign(record, out, { pass: !out.error && out.checks.length > 0 && out.checks.every((c) => c.pass) });
      } catch (e) {
        Object.assign(record, { error: e.message, pass: false, checks: [{ name: "ran to the end", pass: false, detail: e.message }] });
      }
      record.seconds = (Date.now() - caseStarted) / 1000;
      entry.cases.push(record);
      const failedChecks = (record.checks || []).filter((c) => !c.pass).map((c) => c.name);
      line(`${record.pass ? "✓" : "✗"} ${fmt(record.seconds)}${failedChecks.length ? ` · failed: ${failedChecks.join("; ").slice(0, 70)}` : ""}`);
      process.stdout.write("\n");
      save();
    }
    const s = summarize(entry);
    log(`   ${s.casesPassed}/${s.cases} cases passed · median ${s.medianTurnSeconds} s per question · ${s.outputTokensPerSecond} tokens/s · ${s.verdictLabel}`);
  } catch (e) {
    entry.error = e.message;
    log(`   ✗ ${e.message}`);
    save();
  }
  await ollama.unload(name); // free the memory before the next size
}

results.finishedAt = new Date().toISOString();
save();

// The folder to send back, as one archive.
const archive = path.join(ROOT, "reports", `${path.basename(dir)}.tar.gz`);
let packed = false;
try { execFileSync("tar", ["-czf", archive, "-C", path.dirname(dir), path.basename(dir)], { stdio: "ignore" }); packed = true; } catch { /* no tar */ }

log(`\nDone in ${fmt((Date.now() - started) / 1000)}.`);
log(`Report    ${path.join(dir, "report.html")}  (open it in a browser)`);
if (packed) log(`Send back ${archive}\n          It holds the report, the answers and this machine's description (OS, CPU, RAM, GPU); nothing else.`);
else log(`Send back the folder ${dir}`);
