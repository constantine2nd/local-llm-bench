// Ollama's native API: version, models, pull, loaded memory, chat with tools. Unlike its OpenAI-compatible API, it
// reports load, prompt and generation times and returns the thinking separately, which the report needs.
export const OLLAMA_URL = (() => {
  const h = process.env.OLLAMA_HOST || "127.0.0.1:11434";
  return (/^https?:\/\//.test(h) ? h : `http://${h}`).replace(/\/+$/, "");
})();

async function api(pathname, { method = "GET", body, signal, timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  const stop = () => ctrl.abort();
  signal?.addEventListener("abort", stop, { once: true });
  try {
    const r = await fetch(OLLAMA_URL + pathname, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
    const text = await r.text();
    if (!r.ok) throw new Error(`ollama ${pathname} ${r.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`ollama ${pathname}: no answer within ${Math.round(timeoutMs / 1000)} s`);
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
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

// One model call. → { text, thinking, toolCalls, stats: { seconds, loadSeconds, promptTokens, promptSeconds, outputTokens, outputSeconds } }
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
  return {
    text: msg.content || "",
    thinking: msg.thinking || "",
    toolCalls: (msg.tool_calls || []).map((c, i) => ({ id: `call_${i}`, name: c.function?.name, args: parseArgs(c.function?.arguments) })),
    stats: {
      seconds: (Date.now() - started) / 1000,
      loadSeconds: sec(j.load_duration),
      promptTokens: j.prompt_eval_count || 0, promptSeconds: sec(j.prompt_eval_duration),
      outputTokens: j.eval_count || 0, outputSeconds: sec(j.eval_duration),
      doneReason: j.done_reason || null,
    },
  };
}
