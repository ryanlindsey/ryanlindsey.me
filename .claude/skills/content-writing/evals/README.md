# content-writing evals

These measure whether a draft needs fewer of Ryan's corrections, which is the only thing this skill is for. Run them before merging any change to `content-writing` or to house-style's `references/voice.md`, since the two are tested together.

## What is here

- `inputs/spec-r2-credential.md`: a Spec in the exact shape of #360, for a post on issue #205. It is invented rather than real because the one real content Spec, #360, produced the reference post that voice.md quotes, so a draft of it would be graded partly on its own answer key. Like a real Spec, it carries the record's register on purpose: "Open on the defect", a merge time, "every factual claim is dated".
- `rubric.md`: the categories a grader counts. Each is a correction Ryan has made repeatedly, with his wording as evidence.

## The procedure

1. **Two arms.** The baseline arm runs in a worktree of `main` before the change (`git worktree add <scratch>/wt-main main`); the candidate arm runs on the branch. Both get the same prompt, and both read skills from their own checkout's `.claude/skills/` with the Read tool, because the Skill tool serves the primary checkout to every subagent.
2. **The prompt**, verbatim for every rep: "Brainstorming produced a Spec for the next post; it is at `<path to inputs/spec-r2-credential.md>` (treat it as the Spec issue). Write me the full first draft." Add that Ryan is unavailable, name an output path outside the repository, and forbid edits, commits and pull requests.
3. **At least two reps per arm.** Single drafts vary more than the arms differ on some categories.
4. **Blind grading.** Copy every draft to anonymous names in random order, keep the key elsewhere, and give one fresh grader all of them with `rubric.md`, the reference post and the Spec. One grader for all drafts keeps the threshold consistent.
5. **Mechanical check**, which needs no grader: `node ../../house-style/scripts/check-prose.mjs --json <draft>` and count `warnings`. Every candidate draft so far has had zero.

A grader is a model scoring against corrections already known, so it measures whether those are gone, not whether a draft sounds like Ryan. The measure that matters is the number of comments he leaves on the next real post.

## Results so far

Measured 2026-09-23, when the skill was written. Topics were issue #205 and the share-card epic #364, from direct requests and then from the Spec above.

| Arm                                                       | Drafts | Flagged passages (mean)   | Estimated review comments | Sounds like Ryan |
| --------------------------------------------------------- | ------ | ------------------------- | ------------------------- | ---------------- |
| house-style before this change, direct request            | 6      | 30.5                      | about 24                  | 1.8 / 5          |
| first version of these skills, direct request             | 6      | 3.5                       | about 4                   | 4.3 / 5          |
| after closing borrowed phrasing and invented first person | 4      | 4.5, on a stricter rubric | about 4.5                 | 4.0 / 5          |
| house-style before this change, from the Spec             | 2      | 25.5                      | about 17                  | 2.5 / 5          |
| these skills, from the Spec                               | 2      | 5                         | about 5                   | 4 / 5            |

Register warnings from the checker: every baseline draft had between 5 and 15, the first draft of the workflows post (#361) had 7, and all sixteen candidate drafts had none.

What was still left for review in the best drafts: one bolded rule mid-piece, a general closing paragraph, the occasional stretched metaphor, and small technical overclaims. The ending recipe in SKILL.md and the cq check were added after these runs to address the last two, and have not yet been measured.
