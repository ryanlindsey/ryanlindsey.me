# Red pen

The corrections Ryan makes most often to a drafted post, in the order they cost him the most. Search the whole draft for each, including the frontmatter `description`, the `standfirst` and the TL;DR. The house-style checker flags the first three of these as register warnings; it cannot see the rest. Each entry says what to look for and what it becomes. The quoted comments are his.

**Dates and clock times.** Look for calendar dates, times of day, and elapsed durations: "on 22 September", "at 12:04", "eight days earlier", "eighteen minutes later", "within twenty minutes", and phrases that date the piece: "this week", "as of this morning", "every run since has been green". Each becomes nothing, or a relative time where the duration matters to the story: "recently", "the same afternoon", "for a few days". "Drop the calendar dates from this paragraph."

**Commentary on its own evidence.** Look for sentences about how honest, precise or measured the prose is being: "worth being precise about", "worth naming", "worth stating rather than smoothing over", "that is honest rather than an oversight", "I am telling it anyway because", "I did not measure it, so I cannot tell you". Keep the fact the sentence carries, such as what was not measured, and delete the commentary around it.

**Project apparatus.** Look for the spec, the epic, a child issue, the handoff, blocked-by, issue and PR numbers used as narrative, `CLAUDE.md`, "the first pull request", "the agent working the issue", verification tables, any notes block, and names that only mean something inside this repository ("an owner-run script", "the tier", "the harness" without a gloss). Each becomes the engineering event it stood for ("a throwaway branch proved it on the deploy machine") or goes.

**Coined maxims.** Look for bolded or aphoristic lines, especially wordplay and a closing one. Keep at most one rule per piece, in plain words, where the evidence makes it, and never as the final paragraph. "you are overusing it."

**A general ending.** Look at the last section. A paragraph of general advice ("And if…", "When you…") becomes the specific thing the reader can use: the artifact, or a short numbered list of the settings, checks or decisions this piece named.

**Borrowed phrasing.** Look for wording lifted from the reference post or from the examples in voice.md: "with the domain taken out", "decisions a tidy-up would undo", "chose not to pursue that even before measuring". Say the same thing in this piece's own words.

**Invented first person.** Look for every "I did", "I nearly", "I wondered", "I chose". Each must be in the fact sheet. If it is not, attribute it to the work or cut it.

**Own work framed as a defect.** Look for his earlier design described as poor, careless or forgetful, a story that opens on what broke, and sections about the drafting agent's own mistakes: a wrong comment, a wrong PR explanation. Say what worked first; cut the self-correction story. "makes it sound like truly poor design… which is not the case."

**Counts as proof of scale.** Look for the number of Workers, tests, findings, runs, tokens, files, days or cards. Replace with what the thing does and how far it reaches, unless the reader needs the count to follow the mechanism. "it comes off like a brag."

**Exact figures where size is the point.** "2.6 times" becomes "more than double"; "18,873 bytes both times" becomes "byte-identical". Costs, latencies, sizes and the figure an argument turns on stay exact, and so does the error text or diagnostic line that settled a question. Rounding those makes the piece flat, not more like him.

**Abstraction.** Look for metaphors and elegant phrasings: "a repository that moved underneath it", "one credential projected twice", "did not survive contact with". Rewrite in plain computer-science terms, the way it would be said at a whiteboard. "This sounds like AI-speak, not something a human would write."

**Absolutes that do not hold.** Look for "never", "impossible", "cannot", "forever", "the only place", "no path anywhere". Check each against the facts and narrow it to what holds: a one-year cache is not "forever".

**Trailing clauses.** Look for a ", because…" or ", which…" tail at the end of a sentence. Cut it when it restates the sentence or generalizes past the evidence. Keep it when it carries the mechanism a reader would ask about.

**Defensive framing.** Look for a concession nobody asked for about the project being small, personal, or having few users. Delete it, or state the scope as a plain fact. "This section sounds like we're making excuses."
