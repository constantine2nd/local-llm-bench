// Ollama's native API: version, models, pull, loaded memory, chat with tools. Unlike its OpenAI-compatible API, it
// reports load, prompt and generation times and returns the thinking separately, which the report needs.
import http from "node:http";
import https from "node:https";

export const OLLAMA_URL = (() => {
  const h = process.env.OLLAMA_HOST || "127.0.0.1:11434";
  return (/^https?:\/\//.test(h) ? h : `http://${h}`).replace(/\/+$/, "");
})();

// One request to Ollama. Node's built-in fetch gives up after 300 s of waiting for a response, and a local model can
// think for longer, so this uses the HTTP client directly: the only limit is `timeoutMs`. A lost connection (the
// computer slept, Ollama restarted) is retried once; a timeout and an error answer are not.
function request(pathname, { method = "GET", body, signal, timeoutMs = 15000 } = {}) {
  const url = new URL(OLLAMA_URL + pathname);
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = client.request(url, { method, headers: payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {} }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode >= 400) return reject(new Error(`ollama ${pathname} ${res.statusCode}: ${text.slice(0, 300)}`));
        try { resolve(text ? JSON.parse(text) : {}); } catch (e) { reject(new Error(`ollama ${pathname}: unreadable answer (${e.message})`)); }
      });
    });
    const stop = (e) => { req.destroy(e); };
    signal?.addEventListener("abort", () => stop(new Error("aborted")), { once: true });
    if (timeoutMs) req.setTimeout(timeoutMs, () => stop(Object.assign(new Error("timeout"), { timedOut: true })));
    req.on("error", (e) => reject(e.timedOut || e.message === "timeout"
      ? Object.assign(new Error(`ollama ${pathname}: no answer within ${Math.round(timeoutMs / 1000)} s`), { timedOut: true })
      : e));
    req.end(payload);
  });
}

async function api(pathname, options = {}) {
  try {
    return await request(pathname, options);
  } catch (e) {
    if (e.timedOut || /^ollama .* \d{3}:/.test(e.message) || options.signal?.aborted) throw e;
    await new Promise((r) => setTimeout(r, 3000)); // the connection dropped: once more
    try {
      return await request(pathname, options);
    } catch (again) {
      if (again.timedOut) throw again;
      throw new Error(`ollama ${pathname}: lost the connection (${again.message}). Did the computer sleep, or Ollama restart?`);
    }
  }
}

export const version = () => api("/api/version", { timeoutMs: 5000 }).then((j) => j.version);
export const installed = () => api("/api/tags").then((j) => (j.models || []).map((m) => ({ name: m.name, size: m.size })));
export const show = (model) => api("/api/show", { method: "POST", body: { model } });
export const loaded = () => api("/api/ps").then((j) => j.models || []);
export const unload = (model) => api("/api/generate", { method: "POST", body: { model, keep_alive: 0 }, timeoutMs: 60000 }).catch(() => {});

// Streams the download; onProgress(completedBytes, totalBytes, status).
export async function pull(model, onProgress) {
  const r = await fetch(OLLAMA_URL + "/api/pull", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, stream: true }) });
  if (!r.ok) throw new Error(`ollama pull ${model} ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of r.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const j = JSON.parse(line);
      if (j.error) throw new Error(`ollama pull ${model}: ${j.error}`);
      onProgress?.(j.completed || 0, j.total || 0, j.status || "");
    }
  }
}

// Neutral messages ({role, content, toolCalls?, name?}) in Ollama's native shape.
export function toOllamaMessages(system, messages) {
  const out = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "tool") out.push({ role: "tool", content: m.content, tool_name: m.name });
    else if (m.role === "assistant" && m.toolCalls?.length)
      out.push({ role: "assistant", content: m.content || "", tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args || {} } })) });
    else out.push({ role: m.role, content: m.content || "" });
  }
  return out;
}
export const toOllamaTools = (tools) => tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema || { type: "object", properties: {} } } }));

const parseArgs = (a) => { if (a && typeof a === "object") return a; try { return JSON.parse(a); } catch { return {}; } };
const sec = (ns) => (ns ? ns / 1e9 : 0);

// One model call. → { text, thinking, toolCalls, stats: { seconds, modelSeconds, gapSeconds, loadSeconds, promptTokens,
// promptSeconds, outputTokens, outputSeconds } }. `seconds` is wall-clock, `modelSeconds` what Ollama itself reports;
// a large `gapSeconds` between them means the machine paused (sleep), and the report leaves those out of its timings.
export async function chat({ model, system, messages, tools = [], think, ctx, timeoutMs, signal }) {
  const body = {
    model, stream: false, keep_alive: "15m",
    messages: toOllamaMessages(system, messages),
    ...(tools.length ? { tools: toOllamaTools(tools) } : {}),
    ...(think === undefined ? {} : { think }),
    options: { temperature: 0, num_ctx: ctx },
  };
  const started = Date.now();
  const j = await api("/api/chat", { method: "POST", body, signal, timeoutMs });
  if (j.error) throw new Error(`ollama chat: ${j.error}`);
  const msg = j.message || {};
  const seconds = (Date.now() - started) / 1000;
  const modelSeconds = sec(j.total_duration) || sec(j.load_duration) + sec(j.prompt_eval_duration) + sec(j.eval_duration);
  return {
    text: msg.content || "",
    thinking: msg.thinking || "",
    toolCalls: (msg.tool_calls || []).map((c, i) => ({ id: `call_${i}`, name: c.function?.name, args: parseArgs(c.function?.arguments) })),
    stats: {
      seconds, modelSeconds: +modelSeconds.toFixed(2), gapSeconds: +Math.max(0, seconds - modelSeconds).toFixed(1),
      loadSeconds: sec(j.load_duration),
      promptTokens: j.prompt_eval_count || 0, promptSeconds: sec(j.prompt_eval_duration),
      outputTokens: j.eval_count || 0, outputSeconds: sec(j.eval_duration),
      doneReason: j.done_reason || null,
    },
  };
}
