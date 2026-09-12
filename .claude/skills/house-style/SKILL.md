---
name: house-style
description: Ryan's house style for prose on ryanlindsey.me. Drafts, edits, and audits writing in his voice, and enforces the editorial standards mechanically: practitioner-teacher register, near-zero em dashes, American spelling, no contractions, the vocabulary disallow list, and no hard line wrapping. Use this whenever writing or changing any prose in this repo, including posts and case studies under src/content/, page copy, hero and section text, frontmatter descriptions, TL;DRs, and README prose. Use it even when the request does not mention style at all, such as "write an intro paragraph for this post", "tighten this section", "add a description", or "does this read okay". Also use it to audit prose already written, to check a draft before publishing, to unwrap hard-wrapped files, or whenever the question is about em dashes, voice, tone, register, spelling, wrapping, or editorial standards.
---

# House style

Prose on this site carries a specific load. The site argues that its author does the work, so writing that reads as assembled, inflated, or machine-generated costs more here than it would elsewhere. Every rule below exists to protect that, and knowing the reason matters more than obeying the rule, because the rules do not cover every case and the reason does.

**Canonical source.** These standards are a copy. The authoritative statement is section 4, "Voice & editorial standards", of `docs/plan/02-content.md` in the private `ryanlindsey.me.docs` repo, with the register line in `00-overview.md` section 4. When that document changes, this skill needs re-syncing. When the two disagree, that document wins.

**Scope.** Prose in this repo: `src/content/posts/`, `src/content/caseStudies/`, page and component copy, and frontmatter `description` fields. Not code comments, not commit messages, not CHANGELOG entries.

**Out of scope, and worth knowing.** Publication and disclosure constraints, such as which figures may appear in a piece drawn from employer work, are content rules rather than style rules, and they live in the private docs repo with the session records that settled them. Nothing here checks them. A piece can pass every rule in this skill and still be one you cannot publish, so clearing house style is not clearance to ship.

## Two modes

### Drafting or editing

Read `references/voice.md` first. It is the part that cannot be checked mechanically, and it is the part that actually makes the prose sound like him. Then write.

Before handing anything back, run the checker over what you wrote and fix what it finds. The checker is fast and catches the errors that are easy to make and embarrassing to ship.

### Auditing

Start with the checker, because it finds the mechanical problems in under a second and tells you where to focus the reading:

```sh
node .claude/skills/house-style/scripts/check-prose.mjs src/content/**/*.mdx
```

Then read for the things it cannot see: register, structure, whether a claim earns its sentence, whether the opening is concrete, whether a conceded objection is missing. `references/voice.md` has a short diagnostic list at the end for paragraphs that read wrong.

Report findings grouped by severity, with the file and line. Do not rewrite during an audit unless asked. An audit the reader cannot trust to leave their file alone is an audit they will stop running.

### Quoting evidence, and checking your own output

The checker treats blockquotes as verbatim quotations and skips them. That is correct when you are auditing a source file, and it misleads in two ways the moment you are checking your own writing.

**When your review quotes the offending sentence, the error belongs to the source, not to you.** Put the quote in inline code or a blockquote so it is attributed where it belongs and the checker passes over it. Never reword a quotation to satisfy a rule. Misquoting a draft to look compliant is a worse failure than the mark you were avoiding, and it destroys the one thing a review is for.

**When the prose you are delivering sits inside a blockquote, the checker never reads it.** A rewritten paragraph shown back to the reader is the deliverable, and running the checker over the whole response passes the commentary while skipping the rewrite entirely. Write the prose itself to a plain file and check that, rather than the document wrapping it.

## The rules

### Em dashes

**Target zero in published prose.** The em dash is the loudest tell of unedited model output, and this site's credibility argument depends on not reading like one.

Reach for the replacement that fits the job:

| Job                                                    | Mark       |
| ------------------------------------------------------ | ---------- |
| Appositive, an aside naming the thing beside it        | comma pair |
| Definition, or the payoff the sentence was building to | colon      |
| Two independent clauses that belong in one sentence    | semicolon  |
| A clause that carries its own weight                   | full stop  |

An em dash is allowed only where no other mark does the job. The test is that you can say why it is the only mark that works. If you cannot, the sentence wants rewriting, not repunctuating, and the rewrite is almost always better than the sentence you started with.

An en dash with a space on either side, and a double hyphen with a space on either side, are em dashes wearing a disguise, and the same rule covers them. An en dash closed up inside a number range, as in `2024–2026`, is correct typography and is fine.

### Spelling

American English throughout. `modeling`, `behavior`, `color`, `organization`, `artifact`, `gray`, `analyze`, `generalizes`. Verb endings are `-ize` and `-yze`, not `-ise` and `-yse`.

The reason is not patriotism about orthography. Mixing conventions, `modelling` a paragraph away from `organization`, reads as text assembled from several sources rather than written by one person, which is the exact impression the site cannot afford.

### Contractions

Published prose writes them out: `do not`, `cannot`, `it is`, `does not`, `I would`. The one exception is the fixed case-study heading `What I'd do differently`.

This is a real and consistent property of the corpus rather than a rule invented here. The uncontracted form reads a half-step more deliberate, which suits prose whose job is to be trusted.

### Vocabulary disallow list

Two words are banned as metaphors, because they read as precision while carrying none:

- **`seam`** as an architectural metaphor. Name the actual thing: the interface, the boundary, the authorization check, the one place a decision is made.
- **`load-bearing`** as a metaphor for importance. Say what depends on it and what breaks without it.

The test is mechanical. Delete the word. If the sentence still says the same thing, it was filler. If it now says less, a specific claim was hiding behind the metaphor, so write that claim instead.

The list grows by that test as pieces get reviewed. It does not grow by taste. Adding to it means adding to `DISALLOWED` in the checker and to section 4 in the docs repo, in the same change.

### No hard wrapping

One paragraph is one line. No hard wrapping, no manual line breaks inside a paragraph.

Wrapped prose makes every edit a reflow, so diffs on a one-word change touch six lines and review shows motion that is not there. Prettier's `proseWrap` default is `preserve`, so unwrapped files pass `npm run lint` unchanged; this has been verified against the repo config rather than assumed. `src/content/posts/terminal-setup.mdx` already ships this way.

Write new prose unwrapped. When editing a wrapped file, unwrap the paragraphs you touch. Never reflow a file as a side effect of an audit.

To unwrap on request:

```sh
node .claude/skills/house-style/scripts/check-prose.mjs --unwrap <paths>
node .claude/skills/house-style/scripts/check-prose.mjs --unwrap --dry-run <paths>   # preview
```

It preserves frontmatter, fenced code, tables, headings, markup blocks and explicit markdown hard breaks, and it is idempotent. After unwrapping a file, confirm the text survived and the site still builds:

```sh
diff <(tr -s ' \n\t' ' ' < ORIGINAL) <(tr -s ' \n\t' ' ' < UNWRAPPED)   # must be empty
npm run build
```

### Exemptions

Verbatim quotations keep their source's punctuation, spelling and wording. A quoted error message that contains an em dash stays as it is, because misquoting to satisfy a style rule is worse than the em dash. The checker skips blockquotes for this reason.

The docs repo exempts internal working documents under `docs/plan/` and `docs/superpowers/` and session records under `docs/content/resume-interviews/`. Those live outside this repo, so nothing here applies to them.

## Structure

**Case studies** follow a fixed shape, and the shape is load-tested rather than decorative:

```
Context -> Constraint -> Intervention -> Mechanism -> Outcome -> What I'd do differently
```

Mechanism is where the engineering credibility lives, so it gets the most specific writing in the piece. `What I'd do differently` is genuinely self-critical, including problems still open and problems that cannot be measured.

**Every post ships with** a TL;DR, which is also served to agents, a table of contents, and at least one runnable or copyable artifact where one applies.

**Titles state the capability, never a defect.** A title that reads as an accusation against a tool or a practice loses readers who know the subject, and they are the readers worth having.

## Checker reference

```sh
node .claude/skills/house-style/scripts/check-prose.mjs <paths>            # audit, exit 1 on findings
node .claude/skills/house-style/scripts/check-prose.mjs --json <paths>     # machine-readable
node .claude/skills/house-style/scripts/check-prose.mjs --unwrap <paths>   # rewrite, one line per paragraph
```

Rules it enforces: `em-dash`, `en-dash`, `ascii-dash`, `spelling`, `disallowed`, `contraction`, `wrapping`. It ignores fenced code, inline code, link targets, URLs, frontmatter, tables and blockquotes, so it does not fire on an identifier or a href.

It checks the mechanical half only. A file that passes is not therefore in voice, and saying so is the difference between a useful audit and a misleading one.
