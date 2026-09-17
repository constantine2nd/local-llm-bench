// results.json → report.html (one self-contained page) and the verdict per model.
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : null; };
const round = (x, d = 1) => (x == null ? null : +x.toFixed(d));

// Thresholds for the verdict, per model: share of cases passing every check, and the median time of a visitor's
// question (all model calls and tool calls of one turn).
export const VERDICTS = [
  { id: "fit", label: "fit for visitors", minPass: 0.85, maxMedianSeconds: 10 },
  { id: "fallback", label: "only as a fallback", minPass: 0.7, maxMedianSeconds: 25 },
];

export function summarize(model) {
  const cases = model.cases || [];
  const done = cases.filter((c) => !c.skipped);
  const passed = done.filter((c) => c.pass).length;
  const checks = done.flatMap((c) => c.checks || []);
  const turnSeconds = done.filter((c) => c.group !== "roles").flatMap((c) => (c.turns || []).map((t) => t.seconds)).filter((x) => x > 0);
  const rounds = done.flatMap((c) => (c.turns || []).flatMap((t) => t.rounds || []));
  const outRate = rounds.filter((r) => r.outputSeconds > 0).map((r) => r.outputTokens / r.outputSeconds);
  const inRate = rounds.filter((r) => r.promptSeconds > 0).map((r) => r.promptTokens / r.promptSeconds);
  const s = {
    cases: done.length, casesPassed: passed, casePassRate: done.length ? passed / done.length : 0,
    checks: checks.length, checksPassed: checks.filter((c) => c.pass).length,
    errors: done.filter((c) => c.error).length,
    medianTurnSeconds: round(median(turnSeconds)), p90TurnSeconds: round(pct(turnSeconds, 0.9)),
    outputTokensPerSecond: round(median(outRate)), promptTokensPerSecond: round(median(inRate), 0),
    modelCalls: rounds.length, cutOff: rounds.filter((r) => r.doneReason === "length").length, // calls that ran out of room
  };
  const v = VERDICTS.find((x) => s.casePassRate >= x.minPass && s.medianTurnSeconds != null && s.medianTurnSeconds <= x.maxMedianSeconds);
  s.verdict = v ? v.id : "no";
  s.verdictLabel = v ? v.label : "not recommended (too slow or too many failures)";
  return s;
}

const dot = (ok) => `<span class="dot ${ok ? "ok" : "bad"}" aria-hidden="true"></span>`;
const gb = (bytes) => (bytes ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : "–");

function caseHtml(c) {
  const turns = (c.turns || []).map((t) => `
    <div class="turn">
      <p class="q"><b>Q</b> ${esc(t.question).replace(/\n/g, "<br>")}</p>
      ${(t.toolCalls || []).length ? `<p class="tools">tools: ${t.toolCalls.map((x) => `<code>${esc(x.name)}(${esc(JSON.stringify(x.args || {}))})</code>`).join(" ")}</p>` : ""}
      ${t.stoppedAt ? `<p class="dim">stopped: ${esc(t.stoppedAt)}</p>` : ""}
      ${t.corrected ? `<p class="dim">output guard asked again (not from a tool: ${esc(t.corrected.join(", "))})</p>` : ""}
      <div class="a">${esc(t.answer || "(no answer)")}</div>
      <p class="dim">${round(t.seconds)} s · ${(t.rounds || []).length} model call(s) · ${(t.rounds || []).map((r) => `${r.promptTokens}→${r.outputTokens} tok`).join(", ")}</p>
      ${t.thinking ? `<details><summary>thinking (${t.thinking.length} characters)</summary><pre>${esc(t.thinking)}</pre></details>` : ""}
      ${(t.toolResults || []).length ? `<details><summary>tool results</summary>${t.toolResults.map((r) => `<p><code>${esc(r.name)}</code></p><pre>${esc(r.text)}</pre>`).join("")}</details>` : ""}
    </div>`).join("");
  const checks = (c.checks || []).map((k) => `<li>${dot(k.pass)}${esc(k.name)} <span class="dim">${esc(k.detail)}</span></li>`).join("");
  return `<details class="case${c.pass ? "" : " fail"}"${c.pass ? "" : " open"}>
    <summary>${dot(c.pass)}<b>${esc(c.id)}</b> <span class="dim">${esc(c.group)} · ${esc(c.lang)} · ${round(c.seconds)} s</span> ${esc(c.title)}</summary>
    ${c.error ? `<p class="err">error: ${esc(c.error)}</p>` : ""}
    <ul class="checks">${checks}</ul>${turns}
  </details>`;
}

export function renderHtml(results) {
  const models = results.models || [];
  const rows = models.map((m) => {
    const s = summarize(m);
    return `<tr><th scope="row"><code>${esc(m.name)}</code></th>
      <td class="v ${s.verdict}">${esc(s.verdictLabel)}</td>
      <td>${s.casesPassed}/${s.cases} <span class="dim">(${Math.round(s.casePassRate * 100)}%)</span></td>
      <td>${s.checksPassed}/${s.checks}</td>
      <td>${s.medianTurnSeconds ?? "–"} s <span class="dim">/ ${s.p90TurnSeconds ?? "–"} s</span></td>
      <td>${s.outputTokensPerSecond ?? "–"} <span class="dim">/ ${s.promptTokensPerSecond ?? "–"}</span></td>
      <td>${m.loadSeconds != null ? `${round(m.loadSeconds)} s` : "–"}</td>
      <td>${gb(m.memory?.size)} <span class="dim">(${m.memory?.size ? `${Math.round((100 * (m.memory.sizeVram || 0)) / m.memory.size)}% on GPU` : "–"})</span></td>
      <td>${s.errors}</td></tr>`;
  }).join("");
  const mach = results.machine || {};
  const sections = models.map((m) => {
    const cases = [...(m.cases || [])].filter((c) => !c.skipped).sort((a, b) => Number(a.pass) - Number(b.pass));
    return `<section><h2><code>${esc(m.name)}</code></h2>
      ${m.error ? `<p class="err">${esc(m.error)}</p>` : ""}
      <p class="dim">${esc(m.capabilities ? `capabilities: ${m.capabilities.join(", ")}` : "")}</p>${cases.map(caseHtml).join("")}</section>`;
  }).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Local LLM bench · ${esc(results.label || "")}</title>
<style>
  body{font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:24px;color:#1b2430;background:#f6f7f9}
  main{max-width:1100px;margin:0 auto}
  h1{margin:0 0 4px;font-size:24px} h2{margin:32px 0 8px;font-size:19px}
  .dim{color:#5d6b7a} .err{color:#a1261a;font-weight:600}
  table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #dde2e8;border-radius:8px;overflow:hidden}
  th,td{padding:8px 10px;border-bottom:1px solid #eef1f4;text-align:left;vertical-align:top} thead th{background:#eef1f4;font-size:13px}
  .wrap{overflow-x:auto} .v{font-weight:600} .v.fit{color:#1e6b34} .v.fallback{color:#8a5a00} .v.no{color:#a1261a}
  .box{background:#fff;border:1px solid #dde2e8;border-radius:8px;padding:12px 16px;margin:16px 0}
  .box dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:0} dt{color:#5d6b7a}
  details.case{background:#fff;border:1px solid #dde2e8;border-left:4px solid #2e7d45;border-radius:6px;margin:8px 0;padding:8px 12px}
  details.case.fail{border-left-color:#b3261e} summary{cursor:pointer}
  .checks{margin:8px 0;padding-left:18px} .turn{border-top:1px dashed #dde2e8;margin-top:8px;padding-top:8px}
  .a{white-space:pre-wrap;background:#f6f7f9;border-radius:6px;padding:8px 10px}
  pre{white-space:pre-wrap;word-break:break-word;background:#f6f7f9;padding:8px;border-radius:6px;font-size:12.5px;max-height:320px;overflow:auto}
  .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px} .dot.ok{background:#2e7d45} .dot.bad{background:#b3261e}
  code{font-size:13px}
</style></head><body><main>
<h1>Local LLM bench: Marko's AI assistant</h1>
<p class="dim">${esc(results.label || "")} · ${esc(results.startedAt)} → ${esc(results.finishedAt || "unfinished")} · context ${esc(results.settings?.ctx)} · thinking ${esc(results.settings?.think === false ? "off" : "on")}${results.settings?.quick ? " · quick run" : ""}</p>
<div class="box"><dl>
  <dt>Machine</dt><dd>${esc(mach.os)} · ${esc(mach.cpu)} (${esc(mach.cores)} threads) · ${esc(mach.ramGB)} GB RAM</dd>
  <dt>GPU</dt><dd>${(mach.gpus || []).length ? mach.gpus.map((g) => `${esc(g.vendor)} ${esc(g.name)} · ${esc(g.totalGB)} GB`).join("; ") : mach.appleSilicon ? "Apple Silicon (unified memory)" : "none found (CPU only)"}</dd>
  <dt>Ollama</dt><dd>${esc(results.ollama?.version)} at ${esc(results.ollama?.url)}</dd>
  <dt>Benchmark</dt><dd>local-llm-bench ${esc(results.version)} · Marko's facts recorded ${esc(results.dataDate)}</dd>
</dl></div>
<div class="wrap"><table><thead><tr><th>Model</th><th>Verdict</th><th>Cases passed</th><th>Checks</th><th>Answer time median / p90</th><th>Tokens/s out / in</th><th>Load</th><th>Memory</th><th>Errors</th></tr></thead>
<tbody>${rows}</tbody></table></div>
<p class="dim">Verdict: "fit for visitors" = at least 85% of cases pass every check and a visitor's question takes 10 s or less (median); "only as a fallback" = 70% and 25 s. Answer time counts every model call and tool call of one question. Checks are automatic; read the answers below for quality.</p>
${sections}
</main></body></html>`;
}
