# The voice, in detail

Read this when drafting or substantially rewriting. The rules in SKILL.md say what not to do; this says what the prose actually sounds like when it is working. Every quoted line below is from the published corpus.

## Contents

- [The register](#the-register)
- [Ten moves that make the voice](#ten-moves-that-make-the-voice)
- [Rhythm](#rhythm)
- [Register by piece type](#register-by-piece-type)
- [What the voice does not do](#what-the-voice-does-not-do)
- [Revising a paragraph that is off](#revising-a-paragraph-that-is-off)

## The register

Practitioner-teacher: the person who has done it explaining how, not a futurist and not a vendor. First person for his own work, second person for the experience the reader already has. Confident, concrete, numbers where they exist.

The load the voice carries is credibility. This is a site arguing that its author does the work, so prose that reads as assembled, hedged, or inflated costs more here than it would elsewhere. Most of the rules below are downstream of that one fact.

## Ten moves that make the voice

**1. Open on something concrete, never on a thesis.** A number, a failure, or a scene the reader recognizes. The argument arrives second.

> A GitHub Actions workflow of mine discarded roughly 639 driver sessions. There was no error, no failed run, and no alert.

> Every engineering manager I know has had the same bad afternoon. A leader asks when a project will land. You open the epic, squint at the story points, do some arithmetic that is really just vibes with a calculator, and produce a date.

**2. Concede early and flat.** Name the objection before the reader can raise it, in plain declarative, without softening. This buys the rest of the argument.

> That technique is not mine and is not new. Forecasting delivery from observed throughput rather than estimates has been well-documented practice for years. What was worth building was everything around it.

> GitHub already solves the tracking half of this properly, and it is worth being precise about that, because the tempting version of this post is one that invents a deficiency to fix.

**3. Head enumerated points with a bold fragment.** A short declarative sentence or noun phrase in bold, then the explanation in plain prose. It works in lists and as a paragraph lead.

> **Real cycle time from real people.** The simulation draws on how the specific humans on the project have actually completed work, not on an idealized team velocity.

> **A reference has to say which repository it means.** Issue number 278 exists in every repository that has had 278 issues, and they are unrelated.

**4. Define by negation.** Saying what a thing is not, then what it is, is a recurring structural move. It also sets up the reversal the paragraph is built on.

> Nothing was broken. Every run that executed was green. That is the failure mode I now build against.

> The output is deliberately not a single number.

> That is not a design failure. It is the normal shape of a system that has been split along sensible lines.

**5. Let the reason ride with the claim.** Clauses joined by `because`, `which`, or `so` carry their own justification. Assertions that stand alone read as opinion; these read as reasoning.

> It accounts for holidays and PTO, because a forecast that assumes a full team in late December is wrong in a way everyone can see, and one visibly wrong output is enough to discredit a tool.

**6. Land the payoff on the last word.** Sentences end on the word that does the damage, not on a trailing qualifier.

> Leaders pushed on dates because there was little to push against except the manager's confidence, and confidence is not evidence.

> I cannot reconstruct what happened, and the ledger that is supposed to be my second witness saw nothing either.

**7. Give numbers their provenance and their limits.** A number arrives with how it was obtained, or with an honest note that it cannot be verified.

> the only reason I know the number is that I went looking afterward

> I am also driver zero, which is why 67% of last month's inference spend is attributable to me.

> I have not seen it lately. Debriefs are completing and no driver has reported anything. What I cannot tell you is whether it is fixed.

**8. Compress the lesson into a quotable rule.** Findings resolve into a short bolded maxim that a reader could repeat from memory. Earn it first; do not lead with it.

> **a green run is not proof.**

> **a test suite cannot validate the assumption it was derived from.**

> **no file in this repository can tell you what is deployed. Only the deployment can.**

**9. Mark opinion as opinion.** Where a choice is taste rather than evidence, say so, and say where the reader should override.

> I have marked the places where my opinion should probably lose to yours.

> if it does not apply to you, you should skim the config and ignore the argument

**10. Be specific about your own failures, including the ones still open.** The `What I'd do differently` sections are genuinely self-incriminating, and the admission is stated without defensive framing.

> It is a straightforward instrumentation job that I have deprioritized behind features more than once, and writing this down is partly an attempt to stop doing that.

> I knew that in the abstract. I did not notice I had done it, on the input everything else rests on, in a tool the whole engineering org had adopted.

> The blast radius was smaller than it could have been, and not because of anything clever I did.

## Rhythm

Measured across the corpus: median sentence around 17 words, range roughly 7 to 50. The variation is the point.

The characteristic pattern is two or three short declaratives that establish facts, then one longer sentence that does the reasoning over them.

> Nothing was broken. Every run that executed was green. That is the failure mode I now build against, and this is the system I built against it.

Avoid stacking subordinate clauses. When a sentence needs three ideas, it usually wants to be two sentences, and the second one usually starts with `That` or `Which`, picking up the first as its subject.

> Which is the rule the whole platform now runs on, and it is four words long.

## Register by piece type

**Case study.** Fixed shape: Context, Constraint, Intervention, Mechanism, Outcome, What I'd do differently. Mechanism is where the engineering credibility lives, so it gets the most specific writing in the piece. No parenthetical asides; the corpus has none outside link targets. Numbers throughout.

**Argument piece.** Not the case-study shape. Builds a claim across headings that are themselves assertions (`Two things a repository cannot hold`, `What a single checkout cannot see`). Heavier on concession, because the argument is contestable. Quotes real error text from source as evidence rather than describing it.

**Walkthrough.** Second person, imperative, ordered sections the reader executes. Opinion marked more often and more lightly. Parentheses are allowed here where they are not in a case study. Every file given in full and copy-pasteable. Warn before anything destructive.

> A warning worth reading before you paste anything: this replaces your shell configuration.

## What the voice does not do

- Adjectives doing argumentative work. `robust`, `powerful`, `seamless`, `cutting-edge`. Mechanism replaces praise. The corpus says `It works, and the evidence I trust most is not a number`, then gives the evidence.
- Enthusiasm as a substitute for a claim. No `passionate about`, no `excited to share`.
- Hedging stacks. `might potentially`, `it could be argued`. Either the claim holds or it is marked as open.
- Rhetorical questions used as transitions.
- Contractions. Published prose writes `do not`, `cannot`, `it is`. The single exception is the fixed heading `What I'd do differently`.
- Claiming a deficiency in someone else's tool to make room for the argument. Stated explicitly in the corpus as a trap to avoid.
- Describing agent work as continuously monitored. The accurate description is periodic, asynchronous check-ins.

## Revising a paragraph that is off

When a paragraph does not sound right, these are the usual causes, in the order worth checking:

1. It states a conclusion without the fact that produced it. Put the fact first.
2. It uses an adjective where a number or a mechanism belongs. Delete the adjective and see what is missing.
3. It hedges a claim the author actually holds. Say it, or mark it open and say why.
4. It defends instead of concedes. Move the objection to the front and answer it.
5. Its sentences are all the same length. Break one in half.
6. It buries the payoff mid-sentence. Move the sharp word to the end.
