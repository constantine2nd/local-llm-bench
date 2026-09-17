# local-llm-bench

How well do local models run an AI assistant on *your* computer? This benchmark runs the scenarios of
[Marko's AI assistant](https://constantine2nd.github.io/about/) on **qwen3** models through
[Ollama](https://ollama.com), and writes one report with every question, tool call, answer, timing and check.

Everything runs on your machine: the assistant's prompts, its tools (answered from recorded data in `data/`) and the
checks are in this repo. Besides downloading the models, nothing goes over the network, and no cloud model is used.

## Run it

1. Install **[Ollama](https://ollama.com/download)** and start it (the app, or `ollama serve`).
2. Install **[Node.js](https://nodejs.org) 20 or newer**. No other dependencies.
3. In this folder:

   ```bash
   ./run.sh              # Linux, macOS
   run.cmd               # Windows
   ```

The script shows your machine, picks the model sizes that fit, asks before downloading, runs the cases and prints
where the report is. A first try without downloading anything big: `./run.sh --quick --models qwen3:4b`.

When it is done, send back the archive it names (`reports/<date>-<name>.tar.gz`). It contains the report, the
answers, and your machine's description (OS, CPU, RAM, GPU), nothing else.

## Which models, and how long

| Model | Tested when the machine has | Download | Fit for an assistant |
|---|---|---|---|
| `qwen3:4b` | always | ~2.5 GB | a baseline; weak at multi-step tool use and Serbian |
| `qwen3:8b` | 8 GB free GPU memory (or 16 GB RAM without a GPU) | ~5.2 GB | the realistic minimum for real visitors |
| `qwen3:14b` | 12 GB free GPU memory | ~9.3 GB | better grounding and languages |
| `qwen3:32b` | 24 GB free GPU memory | ~20 GB | close to cloud quality, slower |

Apple Silicon counts about 70% of its unified memory. Without a GPU at most `qwen3:8b` is tested, and slowly: on a
laptop CPU one answer can take several minutes. The full run is 18 cases per model; `--quick` runs 9.

## What is tested

Every case uses the assistant's system prompt (security rules, the assistant's instructions, a language hint) and
its tools, runs the tool loop the way the assistant's server does (up to 8 model calls per question, one correction
round when an answer names a link or e-mail that no tool returned), and checks the result automatically:

| Group | Cases | Checked |
|---|---|---|
| Grounded answers | "Who is Marko?", "What does he care about in software?", experience in German and Serbian, projects, skills | the right tool; the answer in the visitor's language (Serbian in Latin script); expected facts; no link or e-mail that is not in a tool result |
| Contact | contact (en, sr), when Marko is free (en, de) | the exact e-mail address or booking link from the tool result |
| Follow-up | "What is his CI/CD experience?" → "Tell me more about that." | both turns grounded in the tool result |
| Quiz | "Can you quiz me about Marko?", "Hajde neki kviz o Marku" | `start_quiz` with the visitor's language (the server runs the quiz from there) |
| Scope | a coding request; a request to repeat its instructions | no code; the instructions stay private |
| Roles | writing a quiz debrief (en, sr); judging five debrief drafts sentence by sentence | at most 3 sentences, the right language, the missed answers; the known bad sentences marked, no others |

Checks are deterministic. Whether an answer is *good* is for a person to judge: the report shows every answer in full,
with the model's thinking and the tool results.

## The report

`reports/<date>-<name>/report.html`, one page to open in a browser:

- the machine: OS, CPU, RAM, GPU, Ollama version;
- per model: cases and checks passed, the time of a visitor's question (median and 90th percentile), tokens per second,
  load time, memory used and how much of it is on the GPU, and a verdict:
  **fit for visitors** (85% of cases pass, a question takes 10 s or less),
  **only as a fallback** (70%, 25 s), or **not recommended**;
- every case: question, tool calls, answer, thinking, tool results, each check; failures first.

`results.json` holds the same data for comparing several machines.

## Options

```
--quick              the short set (9 of 18 cases)
--models a,b         test these models instead of choosing by memory
--cases a,b          only these case ids (see --list)
--no-think           ask thinking models not to think (some qwen3 builds think anyway; the report shows it)
--ctx N              context window in tokens (default 16384)
--timeout S          seconds one model call may take (default 600 without a GPU, 120 with one)
--yes                download models without asking
--label NAME         name in the report and archive (default: the host name)
--resume DIR         continue an interrupted run (a folder in reports/)
--list               show the machine, the chosen models and the cases, then stop
```

Ollama on another address: `OLLAMA_HOST=host:port ./run.sh`. The downloaded models stay in Ollama; remove one with
`ollama rm qwen3:32b`. `npm test` runs the unit tests (against a fake Ollama).

## Notes

- **Context window:** Ollama's default is smaller than the assistant's prompt plus its tool results, so the benchmark
  sets 16384 tokens. A server running an assistant on Ollama needs the same (`OLLAMA_CONTEXT_LENGTH`).
- **Thinking:** qwen3 thinks before answering. The benchmark keeps the thinking apart from the answer and counts its
  time; the `qwen3:4b` build tested so far thinks even when asked not to.
- **Answers differ between runs** (temperature 0 still varies slightly between machines and versions).
- **The data** in `data/marko/` is Marko's published profile as the assistant's tools returned it on the date shown
  in the report.

## License

Apache-2.0
