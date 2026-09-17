// Marko's tools, answered from recorded results (data/marko): the benchmark needs no network besides Ollama itself.
// Two quiz tools exist for the assistant's server, not for its model; the model is offered the others, as in production.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/marko");
export const HIDDEN_TOOLS = ["get_quiz", "answer_quiz_question"];

export function loadTools() {
  const tools = JSON.parse(readFileSync(path.join(DATA, "tools.json"), "utf8"));
  return {
    tools,
    // Recorded once without filter arguments: a filtered tool answers with its full list, which these tools return
    // anyway when a filter matches nothing. The quiz is recorded per language.
    async callTool(name, args = {}) {
      const byLang = path.join(DATA, "recorded", `${name}.${String(args.lang || "en").slice(0, 2)}.json`);
      const plain = path.join(DATA, "recorded", `${name}.json`);
      const file = existsSync(byLang) ? byLang : plain;
      if (!existsSync(file)) return JSON.stringify({ error: `unknown tool ${name}` });
      return JSON.parse(readFileSync(file, "utf8")).text;
    },
  };
}

export const offeredTools = (tools) => tools.filter((t) => !HIDDEN_TOOLS.includes(t.name));

// The day the tool results were recorded: the facts the answers are grounded in.
export const dataDate = () => JSON.parse(readFileSync(path.join(DATA, "recorded", "about_me.json"), "utf8")).recordedAt.slice(0, 10);
