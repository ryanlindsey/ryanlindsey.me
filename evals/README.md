# Evals

Prompts are code (04 §4): they are versioned in `prompts/`, changed by pull
request, and gated by this suite. The suite runs **locally, before merge** —
CI holds no inference credential, and giving it one is a phase-2 question.

```bash
npm run evals -- --endpoint https://mcp.ryanlindsey.me
npm run evals -- --endpoint http://127.0.0.1:8787 --suite tier --no-record
```

## Suites

| Suite  | What it proves                                                                                                                      | Needs a token |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `tier` | The private tier is invisible without a grant, and nothing the public tier says carries search language (09 §2)                     | no            |
| `fit`  | Every golden description produces a schema-valid report with resolvable citations, and the ones that should surface gaps do (03 §4) | yes           |

The `fit` suite reads `RLME_EVAL_TOKEN` from the environment. Export it in
your own shell; it is never an argument and is never printed. Without it the
suite **skips loudly** and reports nothing as passed.

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

## What is not here yet

LLM-judge scoring of grounding, honesty and tone (04 §4). It arrives with the
chat suite on day 6, which is what it was designed for. Everything here is
deterministic on purpose.
