---
title: Acceptable use and data handling
updated: '2026-09-11'
summary: What the AI features on this site do, what they store, for how long, and what they never touch. Every sentence here is checkable against the repository this site is built from.
---

This site is a production system, not a demo. It answers questions from a model,
retrieves from a corpus, and writes some of what happens to a database. This page
says what that means for you, in the order you would want to ask.

It is written to be checked. The site's source is public, and where a paragraph
below describes a mechanism, the mechanism is in that repository under the name
this page gives it. The companion [risk register](#risk-register) says where the
controls are weaker than they sound.

## What these features are for

Three things on this site use a model:

- **Chat** answers questions about published writing, the résumé and the case
  studies, grounded in retrieved passages and cited by number.
- **Fit analysis** compares a description you supply against the published
  corpus and returns a structured report. It is reached only with a scoped
  token.
- **A judge** scores answers against written criteria when the evaluation suite
  runs. It never faces a visitor.

They are all narrow on purpose. Chat is not a general-purpose assistant and
declines to be used as one. Nothing on this site will answer questions about
Ryan's working arrangements, compensation, references or plans — those are
covered in a private tier, and the way to get at them is to ask him.

## Acceptable use

You are welcome to use everything here, including with an agent, including at
volume within the published limits. Two things are not welcome, and both are
enforced rather than requested:

- **Driving spend.** Every inference path is rate limited per caller, a global
  daily cap sits above that, and a budget breaker can stop all of it. Browser
  forms carry a bot check.
- **Probing the private tier.** Routes that are not listed answer exactly what a
  path with no route answers. There is nothing to learn from the difference,
  because there is no difference.

Automated access is not abuse. See [Agents and crawlers](#agents-and-crawlers).

## What is stored, and for how long

**Chat transcripts — 30 days.** Your question, the answer, the model, the
numbered sources the answer was grounded on, how many of them it cited, how many
citation numbers named a source that does not exist, whether the turn succeeded,
how long it took, and whether it came from this site or from the endpoint
directly. Also a session id, which your own browser generates per visit to group
one conversation; it is not a credential and is not stable across visits.

**The tool-call audit trail — 1 year.** One row per call to the MCP server: the
tool, a hash of the arguments, whether the call was public or made under a grant,
the audience and token id of that grant, the client's name, version and user
agent, the protocol version, the outcome, and the duration. Arguments are stored
as a hash, never as text.

**Fit reports — 1 year.** The description that was submitted, the validated
report, the audience of the grant that produced it, the model, and how many
citations were checked and dropped. A report has an unguessable permalink, and
that link is the only key to it — anyone holding it can read it until the window
closes.

**Two things have no window, deliberately.** Rows in the token registry — a
token's id, audience, scopes and timestamps, never its value — are never deleted,
because they are the only key the audit trail has for the credential that made a
call, and deleting one would erase the record that the token ever existed.
Evaluation runs store a suite name, pass and fail counts and a truncated note
naming failing cases; they are summaries of our own test runs and contain nothing
a visitor typed.

**Per-request analytics.** One row per request reaching a Worker, carrying six
bounded labels: a class for the client (agent, browser or unknown), a stable name
for it, a class for the route, a class for the referrer, which surface served it,
and whether the status was 2xx, 3xx, 4xx or 5xx. These are aggregate counters and
nobody can be picked out of them.

## What is never stored

- **No cookies.** This site sets none, and the MCP server refuses to read one: a
  token is presented explicitly on every call, never carried ambiently.
- **No IP address in any table.** There is no address column in the transcripts,
  the audit trail, the fit reports or the analytics rows. Your address is used
  once, in memory, to name the rate-limit counter that applies to you, and is
  discarded with the request. Cloudflare's own edge logging is a separate system
  and is outside what this page can speak for.
- **No fingerprinting.** Classification reads the user agent, the path, the
  `Accept` header, `Sec-Fetch-Mode` and whether a referrer was present. It does
  not read TLS fingerprints, header order, screen dimensions or anything else
  that identifies a person rather than a client, and it stores classes rather
  than raw values — never a full path, a query string or a referrer URL. The MCP
  audit trail is the one exception and says so above: an MCP client identifies
  itself by name and version, and that is kept verbatim for a year.
- **No accounts, and no tracking across visits.** There is nothing to log in to.

## How the private tier is partitioned

Some documents on this site are held for a named audience and reached with a
scoped, expiring token. The separation is structural rather than a filter applied
at read time:

- Gated documents live in a **separate storage bucket**, and the code path that
  serves public documents does not declare a binding to it. A public tool cannot
  leak a private document by forgetting a check, because it holds no reference to
  the bucket.
- Gated tools are **registered per grant**. An unauthenticated listing does not
  contain them, so it cannot name one.
- Unlisted routes answer a **byte-identical copy of this site's own 404** —
  status, body and every header — so a refusal is indistinguishable from a path
  that does not exist.
- Tokens are **scoped and revocable**. Revocation is one row update in a registry
  the server consults on every call, and every gated tool call is recorded with
  the token's id, so revoking one can be followed by an exact answer to what it
  read.

## How retention is enforced

The windows above are a single constant in the code. A scheduled job runs once a
day, deletes everything past its window table by table, and logs one line naming
each table and the number of rows it removed — so a day on which nothing was old
enough and a day on which the job did not run look different from outside. A test
that runs on every build pins the sentences on this page against that constant,
so the number published here and the number the job enforces cannot drift apart.

If a table's delete fails, the others still run and the failure is logged rather
than swallowed. One table falling behind must not hold another table's data past
its stated window.

## Agents and crawlers

Agents are welcome here and are not treated as a problem to be managed.

- `robots.txt` contains **no `Disallow` anywhere**, for any agent. Major
  operators are named in their own groups and allowed explicitly.
- A `Content-Signal` line states the intent behind that permission:
  `search=yes, ai-input=yes, ai-train=no, use=reference`. Indexing, citing and
  retrieval-time grounding are all welcome; using this content to train or
  fine-tune a model is a reserved right rather than a technical control, and
  nothing here can stop a crawler that ignores it.
- [`/llms.txt`](/llms.txt) is a curated index and
  [`/llms-full.txt`](/llms-full.txt) is the whole corpus as plain text.
- Every content page has a **markdown variant** — append `.md`, or send
  `Accept: text/markdown` and get the same bytes.
- An **MCP server** at `https://ryanlindsey.me/mcp` exposes the same corpus over
  a protocol, unauthenticated, with per-caller limits.

Deliberately unindexed pages carry their own `noindex` tag and are kept out of
the sitemap. They are not listed in `robots.txt`, because naming a path in a file
built to be crawled is the opposite of confining it.

## Models, and the gateway they run through

- Chat runs on `anthropic/claude-sonnet-5`.
- Fit analysis runs on `anthropic/claude-opus-5`.
- The evaluation judge runs on `anthropic/claude-sonnet-5`.
- Retrieval embeddings run on `@cf/qwen/qwen3-embedding-0.6b`, a Workers AI
  model, for both the corpus and your query.

Every frontier-model call goes through Cloudflare AI Gateway, tagged with which
surface made it. This site holds no model-provider API key of its own: billing
and the credential both live inside Cloudflare, and a binding cannot leave it.
Two other managed services are used and neither is a model — Cloudflare Turnstile
for the bot check, and Cloudflare Browser Rendering to print the résumé PDF.

Prompts are versioned in git and changed by pull request, like any other code.
They are not secret, and asking chat to show you its instructions will get you a
polite refusal rather than the text — but the file is in the repository, and you
are welcome to read it there.

## Raising a concern

If something here is wrong, if an answer misrepresented a source, or if you want
something you typed deleted before its window closes, email
**hello@ryanlindsey.me** and say so. A deletion request needs enough to find the
row — roughly when, and roughly what was asked.

If the claim you want to check is about a control rather than about your own
data, the source is public and the risk register below is where the weaker
controls are written down on purpose.
