// The eval cases, as the deployed bundle carries them (issue #291).
//
// evals/run.mjs LOADS these with `readdirSync` at run time. This Worker
// cannot: there is no filesystem inside workerd, so every case file is a
// STATIC IMPORT here and esbuild inlines the JSON into the bundle at build
// time. The manifest below is what the runner iterates, and
// tests/evals-cases.test.ts reads the same directory off disk and fails if
// the two ever disagree -- in either direction, because a file added and
// never imported here would make the scheduled suite quietly smaller than
// the one a person runs by hand, with every case in it still passing.
//
// EVERY ENTRY CARRIES `local: false`, AND THAT IS STRUCTURAL RATHER THAN A
// CONVENTION HONOURED HERE. `*.local.json` -- evals/README.md's convention for
// pointing a suite at a real description without committing it -- is
// gitignored, so no such file exists when this module is bundled and none can
// be named by an import. The scheduled path therefore cannot leak a local
// case's id or its model-derived failure text into the remote `eval_runs`
// row, because it holds no reference to one. That is the stronger form of the
// redaction `redactedNotes` (src/lib/evals/record.ts) applies at the row: the
// manual runner filters what it loaded, and this one never loads it.

import type {
  ChatCase,
  FitCase,
  LeakCase,
  LoadedCase,
  TierCase,
} from '../../../src/lib/evals/cases';

import chatAbsent from '../../../evals/cases/chat/absent.json';
import chatArchitecture from '../../../evals/cases/chat/architecture.json';
import chatInjection from '../../../evals/cases/chat/injection.json';
import chatOffTopic from '../../../evals/cases/chat/off-topic.json';
import fitMismatch from '../../../evals/cases/fit/mismatch.json';
import fitPartial from '../../../evals/cases/fit/partial.json';
import fitStrong from '../../../evals/cases/fit/strong.json';
import leakProbes from '../../../evals/cases/leak/probes.json';
import tierInvisibility from '../../../evals/cases/tier/invisibility.json';

/** Tags one imported case file the way `load()` in evals/run.mjs tags one it read. */
const bundled = <T>(testCase: T): LoadedCase<T> => ({ ...testCase, local: false });

/** Every committed case file, by suite. The bundle's half of the drift test. */
export const BUNDLED_CASES: {
  tier: LoadedCase<TierCase>[];
  fit: LoadedCase<FitCase>[];
  chat: LoadedCase<ChatCase>[];
  leak: LoadedCase<LeakCase>[];
} = {
  tier: [bundled(tierInvisibility)],
  fit: [bundled(fitMismatch), bundled(fitPartial), bundled(fitStrong)],
  chat: [
    bundled(chatAbsent),
    bundled(chatArchitecture),
    bundled(chatInjection),
    bundled(chatOffTopic),
  ],
  leak: [bundled(leakProbes)],
};
