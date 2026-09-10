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

**Mint and run in the SAME shell invocation.** "Your own shell" above means a
terminal where state persists between commands — and several ways of running
these do not have one. Claude Code's `!` prefix, `ssh host '…'`, a CI `run:`
step and most task runners each execute in a fresh shell, so an `export` in one
command is gone by the next, and the run that follows reports `RLME_EVAL_TOKEN is
not set in this shell` seconds after you watched the export succeed.

The token is printed once and cannot be recovered, so a lost one is re-minted
rather than found. Put both halves in one invocation:

```bash
RLME_EVAL_TOKEN="$(npm run --silent token -- mint --audience evals-harness \
  --scopes evals,fit --days 1 --signer http://127.0.0.1:8799/__sign)" \
  npm run evals -- --endpoint https://mcp.ryanlindsey.me
```

A `VAR=value command` PREFIX rather than an `export`, and that is the whole fix:
the assignment lives in that command's own environment, so there is no shell
state for a fresh shell to lose. An `export` only works when the same shell
survives to the next command, which is exactly the assumption that does not
hold above.

`--silent` is load-bearing: without it `npm run` prepends its own banner lines to
**stdout**, and the command substitution folds them into the token.

**`--days 1`, not 30.** This token admits its holder to `POST /chat` and to
`judge_answer`, so it is a frontier-model credential — and its value cannot be
recovered once the process that minted it is gone. A long window on an
unrecoverable value buys nothing: it is re-minted far more often than it is
reused, and every lost copy is a live credential nobody holds that has to be
revoked by hand. A day matches how this is actually used, and a copy lost to a
closed shell expires on its own rather than needing cleanup. Minting is one
command; there is no cost to doing it per run.

The token needs the `evals` scope for `chat` and `leak` and the `fit` scope for
`fit` — mint one carrying both. `evals` opens two things and neither is content:
admission to `POST /chat`, which this process cannot get past a bot challenge to
reach, and the gated `judge_answer` tool. See `scripts/token.mjs` for how a mint
works, which is less obvious than it looks: the signing key is readable only
inside a Worker.

A token minted and then lost to a non-persisting shell is a live, registered
credential nobody holds. Revoke it rather than leaving it to expire —
`npm run token -- list` shows the jti, and the `minted …` line the mint wrote to
stderr carries it too:

```bash
npm run token -- revoke --jti <jti>
```

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
gated `judge_answer` tool rather than in this process. The runner holds no
inference credential by design, and there is no provider key for it to hold:
`env.AI.run()` bills through AI Gateway's **Unified Billing** — measured on day
1 as `gatewayMetadata.keySource: "Unified"`, and true whether the call names the
gateway or passes no gateway option at all (10 §5). The Worker's `AI` binding is
the credential, and a binding cannot leave Cloudflare. So the judge has to be
reachable over HTTP, and a registration-gated tool is this repo's existing way to
expose something without publishing that it exists. The eval harness is therefore
a first-class MCP client, which is a fair description of what it is.

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
