# Grading rubric

Each category is something Ryan has repeatedly edited out of AI drafts. Evidence in brackets is his own review wording. For every draft, quote each passage he would flag (verbatim, short), assign one category, and count per category. Do not flag something that is merely imperfect; flag only what matches a category.

- **DATE**: calendar dates, clock times, or precise elapsed durations in prose ("on 22 September", "12:04", "twenty-two hours", "within twenty minutes", "eight days earlier"). [“Drop the calendar dates from this paragraph.”] He replaces these with "recently", "a few days", "the same afternoon" is borderline acceptable, "a day".
- **PRECISION**: exact ratios or figures where the rough size is the point ("2.6 times" -> "more than double"). Cost, latency and user-facing figures that show rigor are fine.
- **SCALE-COUNT**: counts used as proof of scale or effort: number of Workers, tests, findings, runs, days to build, cards rendered. [“comes off like a brag”, “not all that interesting or valuable to declare”]
- **META**: prose commenting on its own honesty, precision or evidence ("I want to be precise about", "worth stating rather than smoothing over", "that is honest rather than an oversight", "I am telling it anyway because", "I will mark this as opinion", labeling claims checkable or not). [He cut "Testimony… I am stating each once" and "I will mark the reasoning as mine".]
- **DEFENSIVE**: pre-emptive concession about small scale, few users, or it being a personal site; apologizing for the project. [“sounds like we're making excuses… fundamentally untrue”]
- **SELF-DEFECT**: framing his own design or past work as poor, careless or forgetful beyond what happened; leading with what broke without first saying what worked; dwelling on the agent's own mistakes (wrong comments, wrong PR explanations) as story material. [“makes it sound like truly poor design… which is not the case”, “worked for as long as I remembered” -> “worked well at first”]
- **APPARATUS**: internal process vocabulary a reader does not need: spec, epic, child issue, handoff, blocked-by, CLAUDE.md, PR numbers as narrative, "notes for Ryan", verification tables. [“strip internal apparatus”]
- **TRAILING-CLAUSE**: a ", because…" / ", which…" tail that restates the obvious or generalizes beyond his evidence. Keep reasons a reader would actually ask for. [“drop this part: , because both of those are gone by the time I return.”]
- **MAXIM**: coined aphorisms or bolded quotable rules, especially more than one per piece or a closing one ("a comment with a type", "Ask which door a key is for"). [“you are overusing it”]
- **ABSTRACTION**: clever or abstract phrasing where plain computer-science framing would do; uncommon or insider terms ("corpus"); invented metaphors. [“This sounds like AI-speak, not something a human would write”, “in basic computer science framing”]
- **OVERCLAIM**: absolutes that do not hold ("impossible", "no path anywhere", "never") where a narrower true claim exists; universal claims he should scope to himself.
- **BORROWED**: phrasing lifted from the reference post or from voice.md's examples ("with the domain taken out", "decisions a tidy-up would undo", "chose not to pursue that even before measuring").
- **CLOSING**: 1 if the final paragraph is general advice or a rule rather than something concrete the reader can use (the artifact, or specific settings, checks or decisions).
- **INVENTED**: first-person actions or thoughts ("I nearly", "I wondered", "I should have read") that the issues and PRs the piece draws on do not support. Check the suspicious ones with `gh`.
- **FLATTENED**: evidence rounded or paraphrased away that the reference post would keep exact: the error text or diagnostic output that settled a question, or a size the argument turns on.

Also give, per draft:

- **Takeaway**: in one sentence, what a reader would take away. Is it clear by the end of the opening section? (yes/no)
- **Estimated edits**: the number of distinct review comments Ryan would need to leave to get this to publishable voice.
- **Sounds like Ryan (1-5)**, judged against his reference post `src/content/posts/choosing-a-workflow-over-a-queue.mdx`.
- **Spec fidelity (1-5)**, when the draft was written from a Spec: does it carry the thesis, cover the substance of each structure item in any order or framing, keep the copyable artifact, and respect "What does not change"? Ryan's voice overrides the Spec's register (dates, "open on the defect"), so declining those costs nothing. List anything substantive dropped.

Ignore fenced code and quoted documentation, and apply the same threshold to every draft.

Output: one table (draft x category counts, estimated edits, score), then per draft the flagged quotes grouped by category.
