// One conversation the way the assistant's server runs it: the system prompt (security rules + the assistant's prompt
// + a language hint), the tool loop (up to 8 model calls per question), tool results wrapped as untrusted data, and
// the output guard's one correction round. The quiz debrief and its judge are separate roles (scenarios.mjs).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SECURITY_PREAMBLE, LANG_HINTS, wrapToolResult, unverifiedRefs, correctionFor } from "./guard.js";
import { offeredTools } from "./tools.mjs";

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/marko");
export const ASSISTANT = JSON.parse(readFileSync(path.join(DATA, "assistant.json"), "utf8"));

export const systemPrompt = (lang) => SECURITY_PREAMBLE + ASSISTANT.system + (LANG_HINTS[lang] ? "\n\n" + LANG_HINTS[lang] : "");

const MAX_ROUNDS = 8;

// → { turns: [{ question, answer, thinking, toolCalls, toolResults, rounds: [stats], seconds, stoppedAt? }], sources,
//     toolResults, error? }. A failing model call (a timeout) ends the conversation but keeps what happened so far.
export async function converse({ chat, tools, model, lang, questions, think, ctx, timeoutMs, onRound }) {
  const system = systemPrompt(lang);
  const offered = offeredTools(tools.tools);
  const messages = [];
  const toolResults = [];
  const turns = [];
  const sourcesText = () => [ASSISTANT.system, ...toolResults.map((r) => r.text)].join("\n");
  for (const question of questions) {
    const turn = { question, answer: "", thinking: "", toolCalls: [], toolResults: [], rounds: [], seconds: 0 };
    turns.push(turn);
    const started = Date.now();
    messages.push({ role: "user", content: question });
    let corrected = false;
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const resp = await chat({ model, system, messages, tools: offered, think, ctx, timeoutMs });
        turn.rounds.push({ ...resp.stats, toolCalls: resp.toolCalls.map((c) => c.name) });
        if (resp.thinking) turn.thinking += (turn.thinking ? "\n---\n" : "") + resp.thinking;
        onRound?.(turn.rounds.length, resp.stats);
        if (!resp.toolCalls.length) {
          const bad = unverifiedRefs(resp.text, sourcesText());
          if (bad.length && !corrected) { // the server asks once more, as here
            corrected = true;
            turn.corrected = bad.map((r) => r.raw);
            messages.push({ role: "assistant", content: resp.text }, { role: "user", content: correctionFor(bad) });
            continue;
          }
          turn.answer = resp.text;
          messages.push({ role: "assistant", content: resp.text });
          break;
        }
        messages.push({ role: "assistant", content: resp.text, toolCalls: resp.toolCalls });
        for (const call of resp.toolCalls) {
          turn.toolCalls.push({ name: call.name, args: call.args });
          // The server takes over when the model starts the quiz: the model's part ends here.
          if (call.name === "start_quiz") { turn.stoppedAt = "start_quiz (the server runs the quiz from here)"; break; }
          const text = await tools.callTool(call.name, call.args || {});
          const r = { name: call.name, args: call.args, text };
          toolResults.push(r); turn.toolResults.push(r);
          messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: wrapToolResult(call.name, text) });
        }
        if (turn.stoppedAt) break;
        if (round === MAX_ROUNDS - 1) turn.stoppedAt = `no answer after ${MAX_ROUNDS} model calls`;
      }
    } catch (e) {
      turn.seconds = (Date.now() - started) / 1000;
      return { turns, sources: sourcesText(), toolResults, error: e.message };
    }
    turn.seconds = (Date.now() - started) / 1000;
    if (turn.stoppedAt?.startsWith("start_quiz")) break;
  }
  return { turns, sources: sourcesText(), toolResults };
}
