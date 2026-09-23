---
name: content-writing
description: 'Use when drafting or revising a whole post or case study for ryanlindsey.me, the technical writing this site publishes about what was built and fixed here, starting from the Spec issue or other artifact a superpowers:brainstorming session produced. Use it before the pull request is opened, since review happens locally. Also use when asked to write up, draft, or turn into a post a technical problem, decision or fix from this repository.'
---

# Content writing

Posts and case studies on this site are technical writing about work done here, and each one starts as the output of a brainstorming session: usually a `Spec:` issue whose Why, structure, sources and exclusions were settled with Ryan. The Spec decides what the piece says. It does not decide how it sounds.

That distinction is the reason this skill exists. A Spec is an internal planning document, and it is written in the same register as the issues, PRs and code comments it cites: dated, measured, numbered, candid about defects. Spec #360 told its draft to "open on the defect" and said "every factual claim is dated", the draft did both, and those were the parts Ryan revised out by hand. Carried into a post, that register reads like a changelog narrated aloud.

This skill runs before the pull request, because a pull request runs CI and is public. Drafting, review and every revision happen locally, and the pull request opens with the piece already published.

**REQUIRED:** use house-style. Read its `references/voice.md` before drafting, and run its checker before handing back. This skill owns the process from Spec to an approved draft; house-style owns every sentence.

## The process

1. **Read the brainstorming artifact.** Usually a `Spec:` issue (`gh issue view <n> --comments`); sometimes a design document. Take from it the thesis, the structure, the sources, and the exclusions under "What does not change".

2. **Gather a fact sheet, outside the repository.** Read every source the Spec names: issues, PRs and their review threads, code, `CLAUDE.md` passages, Cloudflare documentation. Write the facts, figures and exact error text to a scratch file. The fact sheet may be as dated and numbered as the record; the draft may not.

3. **Check the technical claims with cq.** Run a cq `query` for the post's domains, such as `["cloudflare", "r2"]` or `["astro", "workerd"]`, and compare what comes back with the fact sheet. `confirm` a unit the record bears out and `flag` one it contradicts. When the record holds a non-obvious technical finding cq does not have, `propose` it with the project detail stripped. Every technical claim the draft will make must trace to the fact sheet, a documentation link, or a confirmed unit.

4. **Reconcile the Spec with the voice.** Where the Spec's instructions conflict with voice.md, voice.md governs the prose and the Spec governs the substance. The usual conflicts: an instruction to open on the defect (say what worked first), to date every claim (the fact sheet keeps the dates, the post does not), or to label caveats as honest (state the limit plainly). Note each one for the hand-back.

5. **Ask only what the Spec leaves open.** Brainstorming has already settled the thesis and the structure, so do not reopen them. Ask Ryan in one message if the Spec does not say: what a reader who never sees this repository should take away; what worked before the thing broke; anything to leave out. If he is unavailable, answer from the fact sheet and list your answers in the hand-back.

6. **Draft** to the Spec's structure, in the register voice.md describes, on a local branch that is not pushed. Write to `src/content/posts/<slug>.mdx` or `src/content/caseStudies/<slug>.mdx` with `draft: true`. Translate every record-register detail with voice.md's table as you write it, not in a later pass. End the piece on its ending (below).

7. **Red-pen pass.** Go through `red-pen.md` in this directory over the whole draft, including the frontmatter `description`, the `standfirst` and the TL;DR, and fix every hit. Check the Spec's exclusions by hand. Run the house-style checker, fix every finding, and look at every register warning.

8. **Snapshot and hand back.** Copy the draft, unchanged, to `.content-drafts/<slug>.first.mdx`. That directory is gitignored, so the snapshot survives the session and is never pushed. Then hand back: the local URL to read it at, `/writing/<slug>` or `/work/<slug>` under `npm run dev` (drafts render at their route by design), and a short reply listing where you followed voice.md over the Spec, the assumptions you made, and anything from the fact sheet you left out on purpose. The draft file holds only the post: no notes block, no TODOs, no verification tables.

9. **Revise locally** until Ryan approves. His revision requests stay in the session; his own edits land in the file.

10. **Harvest the review.** Once he approves, diff the snapshot against the approved file and reread his revision requests in this session. For each correction that is likely to recur, propose one addition to `red-pen.md` (a pattern and what it becomes) or to voice.md (a move), with his before and after as the evidence. Present them together and write only the ones he approves. A one-off fix to this piece's facts is not a rule, and a pattern he did not correct is not his voice, so neither is proposed. Delete the snapshot once the harvest is done.

11. **Ready the pull request.** Set `draft: false` and `publishedAt`. Run everything CI will: the house-style checker, `npm run check`, then `npm test` with the file staged, because the candidacy scan reads `git ls-files`. Stop there. Opening the pull request is its own step, titled `feat(writing): publish the <x> post`, with the harvest's skill changes, if any, in the same branch.

## The ending

A piece ends on the most concrete thing the reader can take away and use: the copyable artifact, or a short numbered list of specific things to do, each a setting, a check or a decision named in the piece. The reference post ends on three defaults to override, each with its reason. It does not end on a paragraph of general advice, and never on a rule stated for its own sake.

## Common mistakes

| Mistake                                                                            | Fix                                                                                                   |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Following the Spec's register because it is the plan                               | The Spec is the plan for substance. voice.md is the plan for prose                                    |
| Reopening the thesis or structure with Ryan                                        | Brainstorming settled them. Ask only what the Spec leaves open                                        |
| Pushing the branch or opening the pull request for review                          | Review is local. The pull request opens once, with the piece published                                |
| Harvesting without approval, or harvesting a one-off fix                           | Propose each rule with his before and after; write only what he approves                              |
| Narrating the ticket history: spec, epic, child issue, first PR, follow-up PR      | Tell the engineering problem. The tracker is how the work was organized, not what the reader came for |
| Giving the drafting agent's own wrong explanation or stale comment its own section | Leave it out, unless the Spec makes the mistake the subject                                           |
| A technical claim nobody checked                                                   | Trace it to the fact sheet, a documentation link or a confirmed cq unit, or cut it                    |
