---
name: mint-scoped-token
description: Use when minting, listing or revoking a scoped token for an audience: issuing a private-tier link, giving an agent access to gated MCP tools, ending an audience's access, or checking what is outstanding. Handles the campaign lookup, the command, the verification and the link to hand over.
---

# Minting a scoped token

Owner-run, from a terminal where `wrangler` is already logged in. The signing key reaches `scripts/token.mjs` through the environment and from nowhere else, so every mint runs under the password manager that injects it.

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

A link for a reader who will use the browser form needs `fit` alone. A token for an agent usually wants `fit,profile,documents,narrative`. `evals` belongs to the eval harness and travels with nothing else.

Pass `--scopes` on every mint. Omitting it defaults to the whole set, `evals` included, which hands an ordinary reader the harness's own scope.

## Mint

```sh
op run -- node scripts/token.mjs mint \
  --audience <token_audience> --scopes fit,profile --days 30 --note "<why>"
```

`op run` on its own injects nothing. It substitutes `op://` references that are already in the environment, so export `RLME_TOKEN_SIGNING_KEY` as an `op://vault/item/field` reference first, or point `op run --env-file=<file>` at a file holding one. Without that the command stops before it signs anything and says so.

The token prints once, on stdout, and nothing prints it again: the registry stores the claims, not the value. Every other line goes to stderr, so `> token.txt` captures exactly the thing to hand over and none of the commentary.

The command ends by presenting the fresh token to the deployed Worker at `POST /grant`, and it refuses to report success unless the token comes back honored carrying the audience just written. That round trip is the reason to trust the mint rather than a flourish on it. The signing key has two copies, the local one and the write-only Secrets Store copy the Worker reads, and a rotation that misses either makes every token minted afterward fail as `bad_signature`, which reads as a bad token rather than as a stale key.

A failed verification is not a failed mint. The registry row is written before the check runs, deliberately, because a credential nobody can revoke is the worse outcome. So the command prints nothing to stdout, exits 1, and names the jti to revoke. Revoke it, reconcile the two copies of the key, then mint again.

## What to hand over

`https://ryanlindsey.me/fit?t=<token>` for a reader who will use the browser form. The bare token for an MCP client, pointed at `https://mcp.ryanlindsey.me/mcp` and presented as `Authorization: Bearer <token>`.

## Outstanding tokens

```sh
node scripts/token.mjs list
```

One row per token, newest first, carrying its audience, its scopes, and either an expiry or the time it was revoked. It prints no secret material, which is why it is split from `mint` and safe to run in any session.

## Ending access

One token, or every live token for an audience:

```sh
node scripts/token.mjs revoke --jti <jti>
node scripts/token.mjs revoke --audience <token_audience>
```

`--audience` is the kill switch for a campaign, and the campaign's own `status` field is not one. Authorization reads the signature and the registry, never KV, so flipping an entry to `retired` stops nothing that is already in someone's inbox. A revocation takes effect on the next request.

Read the line the command prints before believing an audience is closed. `revoked N token(s) for audience <label>` is the one that did something. `audience <label> has no tokens at all; check the label` means the label is wrong and the real tokens are still live, which on the kill switch is the failure worth catching.
