# Evals

Prompts are code (04 §4): they are versioned in `prompts/`, changed by pull
request, and gated by this suite. The suite runs **locally, before merge** —
CI holds no inference credential, and giving it one is a phase-2 question.

```bash
npm run evals -- --endpoint https://mcp.ryanlindsey.me
npm run evals -- --endpoint http://127.0.0.1:8787 --suite tier --no-record
```

## Suites

| Suite  | What it proves                                                                                                                                                                                                 | Needs a token |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `tier` | The private tier is invisible without a grant, and nothing the public tier says carries search language (09 §2)                                                                                                | no            |
| `fit`  | Every golden description produces a schema-valid report with resolvable citations, and the ones that should surface gaps do (03 §4)                                                                            | yes           |
| `chat` | Grounded answers cite real sources and never a number they were not given, decline off-topic requests, state an honest gap rather than guessing, and do not obey an instruction embedded in a question (04 §1) | yes           |
| `leak` | The public chat neither confirms nor denies what the private tier holds, under eight probes that never use the vocabulary being scanned for (09 §2)                                                            | yes           |

`fit`, `chat` and `leak` read `RLME_EVAL_TOKEN` from the environment. Export it
in your own shell; it is never an argument and is never printed. Without it
those suites **skip loudly** and report nothing as passed.

The token needs the `evals` scope for `chat` and `leak` and the `fit` scope for
`fit` — mint one carrying both. `evals` opens two things and neither is content:
admission to `POST /chat`, which this process cannot get past a bot challenge to
reach, and the gated `judge_answer` tool. See `scripts/token.mjs` for how a mint
works, which is less obvious than it looks: the signing key is readable only
inside a Worker.

`leak` runs LAST, deliberately. It is the private-tier disclosure gate, and a failure
there should be the last thing on screen rather than scrolled past. **A red
`leak` suite blocks the branch**, not just the task.

## Exit codes

| Code | Meaning                                                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `0`  | every requested suite ran, and everything passed                                                                                     |
| `1`  | a requested suite ran and something failed                                                                                           |
| `2`  | a requested suite could not run at all (see the `SKIP` line) — nothing failed, but the run proves less than a bare `0` would suggest |

A real failure always wins over an incomplete run: `1` outranks `2`. Running
the first usage example above with `RLME_EVAL_TOKEN` unset prints

```
PASS tier/invisibility
tier: 1/1
SKIP fit: RLME_EVAL_TOKEN is not set in this shell
fit: skipped
evals: incomplete run -- fit did not execute (exit 2)
```

and exits `2` — `tier` genuinely passed, but the run as a whole did not cover
the fit suite, and the exit code says so rather than reading as a clean `0`.

## The golden cases

`cases/fit/*.json` are invented, generic descriptions. They name no company and
reproduce no real posting — the engine is generic (09 §2), and so are its
fixtures. `partial.json` is the important one: it is built so the record meets
it on one axis and plainly not on another, and its `min_gaps` is what catches
an engine that has started to flatter.

A `cases/fit/*.local.json` file is gitignored (`.gitignore`): drop one there
to point the suite at a real description for one-off testing without ever
committing it. `run.mjs` loads every `.json` file in the directory, so a local
case runs alongside the committed ones automatically.

Gitignored is not the same as unrecorded, though: recording (the default,
turned off by `--no-record`) writes to the **remote** `eval_runs` table, and
that channel does not know about `.gitignore`. So the runner enforces the
redaction itself rather than trusting this paragraph — a case loaded from a
`*.local.json` file never contributes its real id or its failure text to a
recorded row; both are replaced with an opaque `<local case, redacted>`
marker. It still counts toward that row's `total`/`passed`/`failed` numbers,
because a count leaks nothing a real id or a fragment of model output would.

## The judge

`chat` and `leak` score their answers with an LLM judge (04 §4), through the
gated `judge_answer` tool rather than in this process. The reason is that the
runner holds no inference credential by design — the Anthropic key lives in AI
Gateway BYOK and never leaves Cloudflare (10 §3.1) — so the judge has to be
reachable over HTTP, and a registration-gated tool is this repo's existing way
to expose something without publishing that it exists. The eval harness is
therefore a first-class MCP client, which is a fair description of what it is.

The judge is **generic**: it scores text against criteria and knows nothing
about what it is scoring. That is a 09 §2 requirement rather than a preference —
a judge with an opinion about the leak suite would have to carry the vocabulary
the leak suite exists to detect.

Two rules keep a judged run honest, and both are about not manufacturing a
verdict:

- The judge runs **only on an answer that already passed the deterministic
  checks**. Scoring an answer we know is wrong spends a model call to learn
  nothing.
- A judge that did not run is **not a pass and not a failure of the case**. It
  is recorded as `the judge did not run`, which fails the case loudly rather
  than quietly reporting a green suite that scored nothing.

## The golden cases, and why some questions changed

`cases/chat/*.json` are written against the corpus **as published on the day
they were written**, which is the only way a golden case is answerable when a
correct engine runs it. Checked against `https://ryanlindsey.me/llms.txt` on
2026-09-10: the résumé, two case studies, and no posts (the writing is still in
draft).

`architecture.json` was rewritten for exactly that reason. It originally asked
what this site is built on and why it uses two Workers — a question the corpus
cannot answer, because the two-Worker split is the subject of an unpublished
build-log post. It now asks about the sim racing coaching platform's
architecture, which the published case study does cover. The expectation was not
weakened to fit; the question was moved to where the evidence is. Widen this set
as the corpus thickens.

`absent.json` depends on the opposite property: it asks about a doctorate, which
the record genuinely does not contain, while the education section it should
point at instead does exist. If a doctorate is ever published, that case stops
testing the honest-gap path and needs a new subject.

## What is not here yet

Nothing from 04 §4. The deterministic suites and the judge are both here.
