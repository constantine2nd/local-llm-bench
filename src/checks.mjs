// Automatic, deterministic checks of one case. Each returns { name, pass, detail }. Anything that needs judgement
// (is this answer good?) is left to the person reading the report, which shows every answer in full.
import { unverifiedRefs } from "./guard.js";

const lower = (s) => String(s || "").toLowerCase();
const words = (s) => lower(s).match(/[\p{L}]+/gu) || [];

// Language of an answer by common words; Serbian must be in Latin script (the assistant's "sr"), Cyrillic is its own.
const STOP = {
  en: ["the", "and", "is", "he", "his", "of", "to", "in", "with", "a", "for", "on", "you", "can"],
  de: ["und", "der", "die", "das", "ist", "er", "sein", "mit", "nicht", "sie", "ein", "eine", "zu", "auf", "für", "den", "im", "können"],
  sr: ["je", "i", "u", "na", "da", "se", "sa", "za", "od", "koji", "kao", "ili", "njegov", "može", "možete", "marko", "ga", "su"],
};
export function detectLanguage(text) {
  const w = words(text);
  if (!w.length) return { lang: null, scores: {} };
  const cyrillic = (String(text).match(/[Ѐ-ӿ]/g) || []).length;
  const latin = (String(text).match(/[A-Za-z]/g) || []).length;
  const scores = Object.fromEntries(Object.entries(STOP).map(([l, list]) => [l, w.filter((x) => list.includes(x)).length / w.length]));
  if (/[čćšđž]/i.test(text)) scores.sr += 0.05;
  if (/[äöüß]/i.test(text)) scores.de += 0.05;
  let lang = Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
  if (cyrillic > latin) lang = "sr-cyrl";
  return { lang, scores };
}

export const sentences = (text) => String(text || "").replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+(?=[\p{Lu}"„(])/u).filter((s) => /\p{L}/u.test(s));

// Every value of `field` in a JSON tool result, at any depth (the e-mail address, the booking link).
export function valuesIn(json, field) {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (k === field && typeof x === "string") out.push(x); walk(x); }
  };
  try { walk(JSON.parse(json)); } catch { /* not JSON */ }
  return out;
}

export const check = {
  answered: (answer) => ({ name: "answered", pass: String(answer || "").trim().length >= 10, detail: `${String(answer || "").trim().length} characters` }),

  language: (answer, expected) => {
    const { lang, scores } = detectLanguage(answer);
    return { name: `language ${expected}`, pass: lang === expected, detail: `detected ${lang || "none"} (${Object.entries(scores).map(([l, s]) => `${l} ${(s * 100).toFixed(0)}%`).join(", ")})` };
  },

  toolCalled: (calls, anyOf) => {
    const names = calls.map((c) => c.name);
    return { name: `tool: ${anyOf.join(" or ")}`, pass: names.some((n) => anyOf.includes(n)), detail: names.length ? `called ${names.join(", ")}` : "no tool called" };
  },

  toolArg: (calls, tool, arg, expected) => {
    const c = calls.find((x) => x.name === tool);
    const got = c ? String(c.args?.[arg] ?? "") : null;
    return { name: `${tool} ${arg}=${expected}`, pass: got !== null && got.toLowerCase().startsWith(expected), detail: got === null ? `${tool} not called` : `${arg}=${JSON.stringify(c.args?.[arg])}` };
  },

  noTool: (calls) => ({ name: "no tool call", pass: calls.length === 0, detail: calls.length ? `called ${calls.map((c) => c.name).join(", ")}` : "none" }),

  // The output guard: a link or e-mail must come from a tool result (or the assistant's prompt).
  refsFromTools: (answer, sources) => {
    const bad = unverifiedRefs(answer, sources);
    return { name: "links and e-mails from tool results", pass: bad.length === 0, detail: bad.length ? `not from a tool: ${bad.map((r) => r.raw).join(", ")}` : "ok" };
  },

  // A value from a tool result appears in the answer (e.g. the e-mail address, the booking link).
  mentionsToolValue: (answer, toolResults, tool, field) => {
    const values = toolResults.filter((r) => r.name === tool).flatMap((r) => valuesIn(r.text, field));
    const hit = values.find((v) => lower(answer).includes(lower(v).replace(/\/+$/, "")));
    return { name: `answer gives ${tool}.${field}`, pass: !!hit, detail: values.length ? (hit ? hit : `expected one of ${values.slice(0, 2).join(", ")}`) : `${tool} returned no ${field}` };
  },

  mentionsAny: (answer, list, min = 1) => {
    const found = list.filter((w) => lower(answer).includes(lower(w)));
    return { name: `mentions ${min === 1 ? "one" : `${min}`} of: ${list.join(", ")}`, pass: found.length >= min, detail: found.length ? `found ${found.join(", ")}` : "none" };
  },

  mentionsNone: (answer, list, label) => {
    const found = list.filter((w) => lower(answer).includes(lower(w)));
    return { name: label, pass: found.length === 0, detail: found.length ? `contains ${found.map((f) => JSON.stringify(f)).join(", ")}` : "ok" };
  },

  noCode: (answer) => {
    const code = /```|\bdef \w+\(|\bfunction \w+\(|=>\s*\{|\breturn\b.*;/.test(answer || "");
    return { name: "no code written", pass: !code, detail: code ? "contains code" : "ok" };
  },

  maxSentences: (answer, max) => {
    const n = sentences(answer).length;
    return { name: `at most ${max} sentences`, pass: n > 0 && n <= max, detail: `${n} sentences, ${words(answer).length} words` };
  },
};

// The judge role: the sentences a verdict marks bad, matched to the draft's sentences by their first 30 letters.
export function judgeExact(draft, badSentences, expected) {
  const key = (x) => lower(x).replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 30);
  const s = String(draft).split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
  const got = s.map((_, i) => i).filter((i) => badSentences.some((b) => key(b) === key(s[i])));
  const pass = JSON.stringify(got) === JSON.stringify(expected);
  return { name: `judge marks sentences ${JSON.stringify(expected)}`, pass, detail: `marked ${JSON.stringify(got)}` };
}
