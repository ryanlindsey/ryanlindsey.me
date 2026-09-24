# The voice, in detail

Read this when drafting or substantially rewriting. The rules in SKILL.md say what the prose must not do mechanically; this says what it sounds like when it is working.

Where this comes from matters. An earlier version of this file was derived from the published pieces, and those had already been drafted by a model and revised, so it described the model's habits as often as Ryan's. Several of its moves were ones he kept deleting in review. This version is derived from what he changes: his inline review comments, his `suggestion` edits, and the draft history of every published piece. The before and after pairs below are real.

The reference piece is `src/content/posts/choosing-a-workflow-over-a-queue.mdx`. When in doubt about a sentence, find the nearest thing it does and match the move. Its phrasings, and the quoted lines in this file, show a move and are not wording to reuse: a draft that says "with the domain taken out", "decisions a tidy-up would undo" or "chose not to pursue that" because the examples did has swapped one tic for another.

## Contents

- [The register](#the-register)
- [The source is a record, the post is a conversation](#the-source-is-a-record-the-post-is-a-conversation)
- [Moves that make the voice](#moves-that-make-the-voice)
- [How he describes himself](#how-he-describes-himself)
- [Register by piece type](#register-by-piece-type)
- [What the voice does not do](#what-the-voice-does-not-do)
- [Revising a paragraph that is off](#revising-a-paragraph-that-is-off)

## The register

An engineering leader who still ships code, explaining to another engineer a problem he actually solved. Plain computer-science framing, ordinary words, first person for his own work, second person when handing the reader something to use. Confident about what he has seen, and scoped to it.

The load the voice carries is credibility, and on this site credibility comes from the mechanism being right and the claim being exactly as large as the evidence. It does not come from showing the evidence's paperwork.

## The source is a record, the post is a conversation

This is the root of most revisions. A post about something built here is drafted from PRs, issues, `CLAUDE.md` and code comments, and those are written as an engineering record: dated, measured, self-correcting, numbered. That register is right for the repository and wrong for a post. A draft that carries it over reads like a changelog narrated aloud, and every one of the translations below is an edit Ryan has made by hand.

| The record says                                                                                                | The post says                                                                                             |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| a calendar date or clock time: "merged at 12:04 on 2026-09-15", "measured on 22 September"                     | nothing, or a relative time: "recently", "the same afternoon", "for a few days"                           |
| an exact ratio or duration: "2.6 times that budget", "twenty-two hours after"                                  | its rough size: "more than double that budget", "a day after"                                             |
| a count of effort or scale: two Workers, 791 tests, seven days, thirteen cards, five findings                  | what the thing does and how far it reaches; the count only if the reader needs it to follow the mechanism |
| process names: the spec, the epic, its first child, the handoff, blocked-by, issue and PR numbers, `CLAUDE.md` | "the issue I filed", "a throwaway branch", or leave it out; the reader was never in the tracker           |
| a correction of an earlier comment or PR explanation                                                           | leave it out, unless the mistake is the subject of the piece                                              |
| a verification table, a "notes for Ryan" block                                                                 | the one result that settled it, stated in a sentence                                                      |

Figures that show rigor stay: a cost, a latency, a size the argument turns on, the measured 78,222 ms that is more than double a thirty-second budget. The test is whether the reader needs the number to follow the mechanism, or whether it is there to prove work was done. So does the evidence that settled a question: the error text, the one diagnostic line that ruled a theory out. Translating the record means dropping its paperwork, not its evidence, and a draft that rounds every figure and paraphrases every output has over-corrected into something flat.

Every first-person action in a post has to be in the record. If the fact sheet does not say Ryan did, thought or nearly did something, the draft does not say it either; attribute it to the work ("the first fix said", "the obvious tidy-up would") or leave it out.

## Moves that make the voice

**Say what worked before saying what broke.** His own past design gets a fair hearing, because it usually was reasonable and the post loses trust if it pretends otherwise.

> Before: "Until that week it held the visitor's browser open for the whole call."
>
> After: "That worked: the browser waited about eighty seconds and the run produced a result. What it did not survive was the connection."

He rejected the first version because it "makes it sound like truly poor design that impacted user experience, which is not the case."

**Open on the situation, concretely.** A specific call, a specific failure, the thing a reader recognizes. Not a thesis, and not a date.

**Make the claim exactly as large as what holds.** Absolutes get tested against the facts and narrowed, which is different from hedging. "impossible to defend" became "difficult to defend"; "no cross-driver read path anywhere" became "two crossings exist, and each is bounded by a test". Claims about the industry get scoped to him: "implementation artifacts belong in a tracker" became "my businesses require implementation artifacts in a tracker".

**Give a reason only where a reader would ask for one.** Reasoning joined with `because` is part of the voice, but a trailing clause that restates the obvious or generalizes past his evidence gets cut. He deleted ", because both of those are gone by the time I return" and ", which is where most real platforms already are". Keep the `because` that carries the mechanism; drop the one that decorates the claim.

**State opinion plainly, and move on.** "I chose not to pursue that even before measuring anything" replaced "and I will mark the reasoning as mine rather than measured". "That last claim has a limit" replaced "I should be precise about how far that last claim goes". The limit is stated; the prose does not comment on its own honesty.

**Explain in plain computer-science terms.** When a draft reached for an elegant antithesis, "One Worker serves what is already written; the other computes what is not", he replaced it with "One serverless Worker handles the site; the other handles the MCP. Each calls the other directly, with no extra hops." Common words win over precise-sounding ones: he rejected "corpus" for a more familiar term. A platform primitive gets a short gloss or a link on first mention.

**Head enumerated points with a bold fragment.** A short declarative in bold, then the explanation in plain prose. This one is his, and the reference piece uses it throughout.

> **A run has an address and a terminal state.** Every Workflow instance has an id, and I create each one with the permalink id as the instance id.

**Define by negation, when there is a real reversal.** "not narrow, but focused"; "not impossible to defend, it was difficult to defend". Use it where a reader holds the wrong frame, not as a rhythm.

**One rule the reader keeps, bolded once where it is earned.** A piece usually resolves into one rule, stated in plain words at the point the evidence makes it, such as **nothing whose duration is a measured number may be scheduled on a budget that is not.** Coined wordplay ("a comment with a type", "ask which door a key is for") and a bolded maxim added at the end for effect are the model's habit, and he has called a repeated one overused. The last paragraph of a piece is never a bolded rule. A piece ends on the most concrete thing a reader can use: the copyable artifact, or a short numbered list of specific settings, checks or decisions named in the piece, the way the reference post ends on three defaults to override.

**Name the human stakes directly.** Trust, stress, a person holding a link and wanting an answer. Value is stated as what it lets someone else do.

**Argue from what the design lets people do, not from what something cannot do.** When a section justifies a tool, lead with the value it gives the people and agents using it, then show the mechanism. A section built on a limitation invites a factual challenge and undersells the design.

> Before: "Standing inside one checkout, an agent can see the code and the git history and nothing else. It cannot see that the item it is about to pick up has a sibling two repositories over."
>
> After: "Every one of those agents needs the same spec and its own share of the implementation detail. A GitHub Project holds both in one place."

He rewrote the whole section, doubting the limitation was even accurate, to say that the plan lives in one place any harness can act on.

## How he describes himself

"An engineering leader who still ships code." One of several leaders on a team, never the person who runs engineering, never an individual contributor. Side projects are plural, and he founded and manages Pixelsonly Racing. Agents run asynchronously and he checks in on them through the day; nothing about his work is continuously monitored.

Background he shares during drafting, such as mentorship or how the org is shaped, is context for the writer, not copy. A draft that transcribes it "reads like an org chart".

Small scale is not something to apologize for. He deleted "Armature has no users but me, so read it as an illustration" and the paragraph defending a four-driver roster, and replaced the latter with the fact that four drivers is a medium-sized team in that sport.

## Register by piece type

**Case study.** Fixed shape: Context, Constraint, Intervention, Mechanism, Outcome, What I'd do differently. Mechanism gets the most specific writing. `What I'd do differently` is candid about real gaps, stated without defensive framing, and without inventing failures he cannot speak to.

**Build post** (the Building in the open series). A problem met while building this site, the options, the one chosen and why, the pattern with the domain taken out, and what he would tell another engineer. The reader is an engineer with a similar problem, not a reviewer of this repository.

**Argument piece.** Builds a claim across headings that are themselves assertions. Quotes real error text or documentation as evidence rather than describing it. Does not invent a deficiency in someone else's tool to make room for the argument.

**Walkthrough.** Second person, imperative, ordered steps. Opinion marked lightly with "I think" or "if it does not apply to you, skip it". Every file given in full and copy-pasteable. Warn before anything destructive.

## What the voice does not do

- Praise adjectives in place of mechanism: `robust`, `powerful`, `seamless`, `cutting-edge`.
- Enthusiasm as a claim: `passionate about`, `excited to share`.
- Hedge stacks: `might potentially`, `it could be argued`.
- Rhetorical questions as transitions.
- Contractions in published prose. The fixed heading `What I'd do differently` is the exception, and he has allowed a contraction in a short page heading.
- Describing his own reasonable design as a defect, or dwelling on the drafting agent's own earlier mistakes as story.

## Revising a paragraph that is off

In the order worth checking:

1. It carries the record's register: a date, a count, a process name, a correction. Translate it with the table above.
2. It comments on its own honesty, precision or evidence. Delete the commentary and keep the claim.
3. It leads with what broke. Say what worked first.
4. It ends on a clause that restates or generalizes. Cut at the comma.
5. It uses an absolute that does not hold. Narrow it to what does.
6. It is clever where it could be plain. Say it the way you would explain it to a colleague at a whiteboard.
7. It states a conclusion without the fact that produced it. Put the fact first.
