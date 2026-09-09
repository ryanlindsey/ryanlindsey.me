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

## What is not here yet

LLM-judge scoring of grounding, honesty and tone (04 §4). It arrives with the
chat suite on day 6, which is what it was designed for. Everything here is
deterministic on purpose.
