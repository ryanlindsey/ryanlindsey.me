---
name: mint-scoped-token
description: Use when minting, listing or revoking a scoped token for an audience. That covers issuing a private-tier link, giving an agent access to gated MCP tools, ending an audience's access, or checking what is outstanding. Handles the campaign lookup, the command, the verification and the link to hand over.
---

# Minting a scoped token

Owner-run, from the repository root, in a terminal where `wrangler` is already logged in. The root is not incidental: `--binding` resolves through the `wrangler.jsonc` in the working directory, and the script is reached by a relative path. The signing key reaches `scripts/token.mjs` through the environment and from nowhere else, so every mint runs under the password manager that injects it.

## Before minting

Read the campaign entry rather than typing an audience label from memory:

```sh
npx wrangler kv key list --binding KV_CONFIG --prefix campaign: --remote
npx wrangler kv key get campaign:<id> --binding KV_CONFIG --remote
```

The `token_audience` field is the `--audience` argument. It is a separate field from `id` and the two are allowed to differ, so substituting one for the other mints a token that matches no campaign: `/fit` opens on an empty form, and `get_application_narrative` falls back to the conventional key for an audience label nobody deployed a document under. Both failures land on the reader rather than here.

## Scopes

A closed set, and a token carries only what its reader needs.

| Scope       | Unlocks                                                               |
| ----------- | --------------------------------------------------------------------- |
| `fit`       | `analyze_fit`, and with it the `/fit` page                            |
| `profile`   | `get_availability`, `get_references`, `get_compensation_expectations` |
| `documents` | `get_case_study_details`                                              |
| `narrative` | `get_application_narrative`                                           |
| `evals`     | `judge_answer`, and admission to `POST /chat` without a bot challenge |
| `authoring` | `get_narrative_brief`                                                 |

A link for a reader who will use the browser form needs `fit` alone. A token for an agent usually wants `fit,profile,documents,narrative`.

Two of these never travel on a reader's token, and they are the two withheld from public metadata, so a reader has no way to learn they exist and no reason to be handed one.

`evals` belongs to the eval harness, whose own token is not this document's business: it carries `evals,fit`, it lasts a day rather than thirty because it is a frontier-model credential, and `evals/README.md` gives the command with the reasoning attached. Mint it from there.

`authoring` belongs to the owner's drafting client, which reaches `mcp.ryanlindsey.me` and nothing else of ours and so reads the brief that governs a narrative document over HTTP. `get_narrative_brief` answers with that brief and with the key the audience's document belongs at, which is the one thing a writer outside every repository cannot work out for itself. The scope landed one issue ahead of the tool, so a token minted before that unlocked nothing; both are in place now. It is deliberately not `evals` reused: an eval-harness token that also unlocked authoring material would be exactly the merge the scope list exists to prevent.

`--scopes` is required. A mint without it refuses and points at this document instead of choosing for you, which is the standing instruction to pass the flag on every mint made structural rather than advisory.

It defaulted to the whole set until 2026-09-17, `evals` and `authoring` included, and both of those open something: a reader handed that token got the harness's judge and the owner's brief, which also names any audience's private-tier key back to whoever asks. The default was harmless while `authoring` opened nothing and stopped being harmless the day `get_narrative_brief` landed. That is recorded here rather than deleted because tokens minted under it may still be live, so a `list` row carrying all six scopes is a forgotten flag until something says otherwise, and a mint to revoke rather than a wide token.

## Mint

```sh
op run -- node scripts/token.mjs mint \
  --audience <token_audience> --scopes fit,profile --days 30 --note "<why>"
```

`op run` on its own injects nothing. It substitutes `op://` references that are already in the environment, so export `RLME_TOKEN_SIGNING_KEY` as an `op://vault/item/field` reference first, or point `op run --env-file=<file>` at a file holding one. Without that the command stops before it signs anything and says so.

The token prints once, on stdout, and nothing prints it again: the registry stores the claims, not the value. Every other line goes to stderr, so `> token.txt` captures exactly the thing to hand over and none of the commentary.

The command ends by presenting the fresh token to the deployed Worker at `POST /grant`, and it refuses to report success unless the token comes back honored carrying the audience just written. That round trip is the reason to trust the mint rather than a flourish on it. The signing key has two copies, the local one and the write-only Secrets Store copy the Worker reads, and a rotation that misses either makes every token minted afterward fail as `bad_signature`, which reads as a bad token rather than as a stale key.

A failed verification is not a failed mint. The registry row is written before the check runs, deliberately, because a credential nobody can revoke is the worse outcome. The command prints nothing to stdout, exits 1, and names the jti on a `MINTED BUT NOT VERIFIED` line. Revoke that jti whatever the cause: the value never reached stdout, so nobody holds it and the row is all that is left of it.

Then read the rest of that line before chasing a cause, because only one of its branches is evidence about the key. A 404 from `POST /grant` is a refusal, and the likeliest reason for one is that the two copies have drifted apart. Anything else, a Worker that could not be reached or a status that is neither a grant nor a refusal, leaves the token unverified rather than known bad, and reconciling a key that never rotated is the wrong hunt.

## What to hand over

`https://ryanlindsey.me/fit?t=<token>` for a reader who will use the browser form. The bare token for an MCP client, pointed at `https://mcp.ryanlindsey.me/mcp` and presented as `Authorization: Bearer <token>`.

## Outstanding tokens

```sh
node scripts/token.mjs list
```

One row per token, newest first: the jti, the audience, the scopes, and either an expiry or the time it was revoked. This is where a jti comes from, and the `minted` line the mint wrote to stderr carries it too. It prints no secret material, which is why it is split from `mint` and safe to run in any session.

## What a token has read

```sh
node scripts/token.mjs calls --jti <jti>
node scripts/token.mjs calls --audience <token_audience>
```

One line per token, tool, outcome and client, with a count and the first and last call times. Exactly one of the two flags. This is the owner's window onto the private tier and the only one: `/ops` is aggregate and public-tier only by design, so nothing there names an audience or a token. A `-` in the client column means the client sent no `clientInfo` envelope, which every client on a 2025-era protocol does; it is not a missing row.

## Ending access

One token, or every live token for an audience:

```sh
node scripts/token.mjs revoke --jti <jti>
node scripts/token.mjs revoke --audience <token_audience>
```

`--audience` is the kill switch for everything token-gated, and it reaches nothing else. Authorization reads the signature and the registry, never KV, so a revocation takes effect on the next request, and flipping the campaign's entry to `retired` neither expires a token already sitting in someone's inbox nor refuses a later mint.

Read the line the command prints before believing an audience is closed. `revoked N token(s) for audience <label>` is the one that did something, and `all N token(s) for audience <label> were already revoked` is the benign repeat. `audience <label> has no tokens at all; check the label` is the one to stop on: it means the label is wrong and the real tokens are still live, which on the kill switch is the failure worth catching.

## Closing a campaign

Two acts, and revocation above is only the first. The referrer-adaptive hero band carries no token, which is why revocation cannot reach it: it renders for anyone arriving from the campaign's referrer domains until the campaign's own KV entry says `retired`, the one thing that field selects (00 §5, 04 §3). Read the entry as in [Before minting](#before-minting), change `status`, and put it back.

Revoke the tokens and flip the status. Doing one of them closes half a campaign.
