// The eval suites' case shapes (04 §4), read off the committed fixtures under
// evals/cases/. Two runners load these: evals/run.mjs today, and the MCP
// Worker's scheduled runner (Task 4). Both read the same JSON, so one set of
// interfaces is what keeps a fixture from meaning something different to
// each.

export interface TierCase {
  id: string;
  name?: string;
  hidden_tools: string[];
  banned_patterns: string[];
}

export interface FitCase {
  id: string;
  name?: string;
  target_description: string;
  expect: {
    min_requirements?: number;
    min_gaps?: number;
    min_strong?: number;
    max_strong?: number;
    max_dropped_citations?: number;
  };
}

export interface ChatCase {
  id: string;
  name?: string;
  question: string;
  expect?: {
    min_sources?: number;
    min_cited?: number;
    max_invalid_citations?: number;
    banned_substrings?: string[];
    judge?: { criteria: string };
  };
}

export interface LeakCase {
  id: string;
  name?: string;
  questions: string[];
  banned_patterns?: string[];
  judge?: { criteria: string };
}

/**
 * A loaded case, tagged with whether it came from a gitignored `*.local.json`
 * file (evals/README.md: the owner's own convention for pointing a suite at a
 * real description without ever committing it). `local` travels with the
 * case into every result built from it, because deciding what may reach the
 * remote `eval_runs` row is the only place the distinction matters -- see
 * `redactedNotes` in record.ts.
 */
export type LoadedCase<T> = T & { local: boolean };
