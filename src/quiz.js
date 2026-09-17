// A quiz about Marko, scored without the model, and the two model roles at its end, as used in production:
//   - the debrief: the model writes a short result for the visitor from the recap (KNEW / MISSED);
//   - the judge: a model checks that debrief sentence by sentence (DEBRIEF_JUDGE_SYSTEM).
// The benchmark builds a quiz result with startQuiz/answerQuiz and gives both roles to the local model.

export const KEYS = "ABCDEF";

const TEXT = {
  en: { score: "You got {c} of {n}.", correct: "Correct!", wrong: "Wrong. The answer was {c}.", stopped: "Quiz stopped.", pick: "Pick one of the answers below.", gone: "That quiz is no longer running; you can start a new one." },
  de: { score: "{c} von {n} richtig.", correct: "Richtig!", wrong: "Falsch. Richtig war {c}.", stopped: "Quiz beendet.", pick: "Wähle eine der Antworten unten.", gone: "Dieses Quiz läuft nicht mehr; du kannst ein neues starten." },
  sr: { score: "Tačno: {c} od {n}.", correct: "Tačno!", wrong: "Netačno. Tačan odgovor je {c}.", stopped: "Kviz je prekinut.", pick: "Izaberite jedan od odgovora ispod.", gone: "Taj kviz više nije aktivan; možete pokrenuti novi." },
  "sr-cyrl": { score: "Тачно: {c} од {n}.", correct: "Тачно!", wrong: "Нетачно. Тачан одговор је {c}.", stopped: "Квиз је прекинут.", pick: "Изаберите један од одговора испод.", gone: "Тај квиз више није активан; можете покренути нови." },
};
export const quizText = (lang, key, c = "", n = "") => (TEXT[lang] || TEXT.en)[key].replace("{c}", c).replace("{n}", n);

const norm = (s) => String(s || "").toLowerCase().replace(/[\s\p{P}]+/gu, "");

// Strict on purpose: "B", "b)", "B) Scala", "2" or the exact text of a choice. "Tell me more about Scala" is a
// question for the model, not an answer.
export function pickKey(input, q) {
  if (!q) return null;
  const c = String(input || "").trim();
  const m = /^([A-Fa-f])(?:\s*[).:]\s*.*|\s*)$/su.exec(c);
  const byLetter = m ? m[1].toUpperCase() : /^[1-6]$/.test(c) ? KEYS[Number(c) - 1] : null;
  if (byLetter) return q.choices.some((x) => x.key === byLetter) ? byLetter : null;
  const hit = q.choices.find((x) => norm(x.text) === norm(c));
  return hit ? hit.key : null;
}

const shuffled = (arr, random) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

// The session state for a quiz from get_quiz's result. Choices are shuffled per quiz (and keyed A, B, … again), so
// "Play again" is not answered from memory of positions; the order of the questions stays.
export function startQuiz(whole, lang, random = Math.random) {
  if (!whole || !Array.isArray(whole.questions) || !whole.questions.length) throw new Error("quiz: no questions");
  const questions = whole.questions.map((q) => {
    const right = q.choices.find((c) => c.key === q.answer);
    if (!right) throw new Error(`quiz: question ${q.number} has no answer among its choices`);
    const choices = shuffled(q.choices, random).map((c, i) => ({ key: KEYS[i], text: c.text, right: c === right }));
    return { id: q.id, question: q.question, choices, explanation: q.explanation || "" };
  });
  return { id: whole.quiz, lang, title: whole.title || "", intro: whole.intro || "", outro: whole.outro || "", instructions: whole.debrief?.instructions || "",
    questions, answers: [] };
}

const current = (s) => s.questions[s.answers.length];
const choiceLabel = (c) => `${c.key}) ${c.text}`;
const score = (s) => ({ correct: s.answers.filter((a) => a.correct).length, answered: s.answers.length });

// Checks the pick for the open question and moves on. → { text, quiz }, or null for a pick that is not one of the choices.
export function answerQuiz(s, input) {
  const q = current(s);
  const key = pickKey(input, q);
  if (!key) return null;
  const picked = q.choices.find((c) => c.key === key), right = q.choices.find((c) => c.right);
  s.answers.push({ id: q.id, key, correct: picked === right });
  const { correct, answered } = score(s);
  const finished = answered === s.questions.length;
  return {
    text: picked === right ? quizText(s.lang, "correct") : quizText(s.lang, "wrong", choiceLabel(right)),
    quiz: { number: answered, correct: picked === right, yourChoice: choiceLabel(picked), correctChoice: choiceLabel(right),
      score: { correct, answered, total: s.questions.length }, finished, ...(finished && s.outro ? { outro: s.outro } : {}) },
  };
}

// One line for the model's history instead of every question: enough to talk about the quiz afterwards.
export function historyLine(s) {
  const { correct, answered } = score(s);
  const all = s.answers.filter((a) => !a.correct).map((a) => s.questions.find((q) => q.id === a.id).question);
  const missed = all.length > 5 ? [...all.slice(0, 5), `${all.length - 5} more`] : all;
  const end = answered === s.questions.length ? "finished" : `stopped after ${answered} of ${s.questions.length} questions`;
  return `(The quiz "${s.title}" ${end}: ${correct} of ${answered} correct.${missed.length ? ` Missed: ${missed.join(" | ")}` : ""})`;
}

// The result as data for the debrief, split into what the visitor knew and what they missed (with the correct answer
// and its explanation): a small model mixed right and wrong up when every answer was listed in one sequence.
// Also the main source the debrief is checked against.
export function recap(s) {
  const { correct, answered } = score(s);
  const rows = s.answers.map((a) => {
    const q = s.questions.find((x) => x.id === a.id);
    return { q, a, picked: q.choices.find((c) => c.key === a.key), right: q.choices.find((c) => c.right) };
  });
  const knew = rows.filter((r) => r.a.correct).map((r) => `- ${r.q.question} → ${r.right.text}`);
  const missed = rows.filter((r) => !r.a.correct).map((r) => `- ${r.q.question} → picked: ${r.picked.text}; correct: ${r.right.text}. ${r.q.explanation}`);
  return `Quiz "${s.title}", language ${s.lang}: ${correct} of ${answered} correct${answered < s.questions.length ? ` (stopped after ${answered} of ${s.questions.length})` : ""}.\n\n` +
    `KNEW (answered correctly):\n${knew.join("\n") || "(none)"}\n\nMISSED (answered wrong):\n${missed.join("\n") || "(none)"}`;
}

export const DEBRIEF_INSTRUCTIONS =
  "QUIZ DEBRIEF\nThe visitor has just ended the quiz. The last message holds their result as data, split into KNEW and MISSED. " +
  "The score is already shown to them in a card.\n" +
  "1. At most 3 sentences and 70 words, in the language of the quiz, addressed to the visitor.\n" +
  "2. One sentence on what they knew (only topics under KNEW). One or two sentences with the correct facts behind one or two " +
  "MISSED items, taken from their explanations. If MISSED is empty, say they knew everything.\n" +
  "3. If the conversation before the quiz touched one of these topics, connect to it in a few words.\n" +
  "4. You may end with a short suggestion of what to ask next.\n" +
  "5. Add no fact, number, name, opinion or strengthening word (always, extensive, leading) that is not in the result; never " +
  "say they knew something listed under MISSED. No score, no list, no headings, no markdown.";

// The judge: one verdict per sentence with a reason; sentences addressed to the visitor are fine.
export const DEBRIEF_JUDGE_SYSTEM =
  "You check a short quiz debrief that a chat assistant wrote to a visitor of a person's website. The SOURCES hold the " +
  "visitor's quiz result (KNEW: questions they answered correctly, with the answer; MISSED: questions they got wrong, with " +
  "the correct answer and its explanation) and may hold other published facts about the person. Everything in the SOURCES is true.\n" +
  "For EACH sentence of the DRAFT decide:\n" +
  "- \"ok\" when every statement about the person in it is in the SOURCES, in the same or in other words. Stating the correct " +
  "answer or the explanation of a MISSED question is ok. Telling the visitor they knew something listed under KNEW is ok. " +
  "A sentence that only talks to the visitor (praise, thanks, a suggestion of what to ask next) is ok.\n" +
  "- \"bad\" only when it (1) adds a fact, number, date, name, opinion or belief about the person that is not in the SOURCES, " +
  "(2) makes a fact stronger than the SOURCES say (\"always\", \"extensive\", \"one of the best\", \"leading\"), (3) says the " +
  "visitor knew something listed under MISSED, or missed something listed under KNEW, or (4) is garbled so that it says " +
  "something false about the person or the visitor.\n" +
  "A sentence with one bad part is bad.\n" +
  "Reply with JSON only: {\"sentences\": [{\"sentence\": \"<the sentence exactly as in the DRAFT>\", \"reason\": \"<short>\", \"verdict\": \"ok\" | \"bad\"}]}";
export const debriefJudgePrompt = (sources, draft) => `SOURCES:\n${sources}\n\nDRAFT:\n${draft}`;

// → the sentences judged bad (possibly none), or null when the verdict is not usable.
export function parseSentenceVerdict(text) {
  try {
    const m = String(text || "").match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : text);
    if (!Array.isArray(j.sentences)) return null;
    return j.sentences.filter((x) => x && x.verdict === "bad" && typeof x.sentence === "string" && x.sentence.trim()).map((x) => x.sentence);
  } catch { return null; }
}
