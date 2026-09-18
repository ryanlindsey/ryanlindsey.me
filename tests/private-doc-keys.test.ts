import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

import {
  AUTHORING_KEYS,
  PROFILE_KEYS,
  caseStudyDetailKey,
  narrativeKey,
} from '../src/lib/tier/private-docs';

/**
 * THE DRIFT THIS FILE EXISTS TO CATCH. scripts/private-doc.mjs's header says
 * "Keys must match what src/lib/tier/private-docs.ts builds", and until this
 * suite nothing asserted it. The two are separate by design -- the script
 * re-checks the shape rather than trusting the caller, because a typo there
 * produces a document no tool will ever find and no error anyone will ever
 * see -- and that same separation lets a namespace land on the reader while
 * the deploy script still refuses it. It did: `authoring/` arrived in
 * AUTHORING_KEYS one issue before the script learned the word, and the only
 * symptom would have been an operator unable to deploy a document the server
 * was already asking for.
 */
const SCRIPT = fileURLToPath(new URL('../scripts/private-doc.mjs', import.meta.url));

/**
 * A path that does not exist, which is how a key the script ACCEPTS still
 * stops before R2: `put` runs requireKey() first and the `--file` existence
 * check second, so an accepted key dies on the missing file and a refused one
 * dies earlier still. The only thing in that function that reaches the network
 * is the `wrangler(...)` call after both.
 */
const MISSING_FILE = '/nonexistent/private-doc-keys.test.md';

/**
 * What the script says about `key`, without letting it reach R2.
 *
 * `PATH: ''` is the part that makes "no network" a property of this code
 * rather than of the filesystem, and it is here because the ordering it
 * replaces was too clever to trust. Asserting MISSING_FILE's absence in a
 * separate test does not gate anything: a failing `expect` does not abort the
 * file, so the spawns below would run anyway, and on the owner's machine the
 * wrangler OAuth login would make them SUCCEED -- writing junk into
 * ryanlindsey-me-private before any assertion could say so. With no PATH, the
 * script's own `execFileSync('npx', ...)` cannot resolve a binary at all, so
 * wrangler is unreachable whatever the file check does. `process.execPath`
 * rather than `'node'` because libuv resolves the spawned binary against the
 * CHILD's PATH, and a bare name with an empty PATH is itself ENOENT
 * (measured 2026-09-17, both halves).
 */
function keyVerdict(key: string): 'accepted' | 'refused' {
  try {
    execFileSync(process.execPath, [SCRIPT, 'put', '--key', key, '--file', MISSING_FILE], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: '' },
    });
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? '');
    if (stderr.includes(`no such file: ${MISSING_FILE}`)) return 'accepted';
    if (stderr.includes('key must be')) return 'refused';
    // An ENOENT on `npx` lands here rather than passing for a verdict, which
    // is what makes the guard above loud instead of silently permissive.
    throw new Error(`neither verdict came back for ${key}:\n${stderr}`);
  }
  throw new Error(`${MISSING_FILE} exists, so this suite just tried to deploy`);
}

test('the deploy script accepts every key the private tier builds', () => {
  const keys = [
    ...Object.values(PROFILE_KEYS),
    ...Object.values(AUTHORING_KEYS),
    caseStudyDetailKey('retention-sweep'),
    narrativeKey('rehearsal'),
  ];

  // The two builders return `null` for a segment that is not a segment, and a
  // null here would quietly shrink this list to whatever still passed.
  expect(keys).not.toContain(null);

  for (const key of keys) expect(keyVerdict(key as string), key as string).toBe('accepted');
});

test('the deploy script refuses a traversal, a hidden name, an unknown namespace and a non-document', () => {
  // Traversal first, because it is the one a key argument could smuggle: the
  // pattern has no `/` outside the namespace alternation, so `..` cannot ride
  // in on a name the reader would have refused.
  expect(keyVerdict('authoring/../profile/compensation.md')).toBe('refused');
  expect(keyVerdict('authoring/.hidden.md')).toBe('refused');
  expect(keyVerdict('secrets/anything.md')).toBe('refused');
  expect(keyVerdict('authoring/narrative-brief.txt')).toBe('refused');
});

test('the script is LOOSER than safeSegment about a dotted name, and that is the known gap', () => {
  // NAMED rather than asserted the other way round, because the honest title
  // for the test above would otherwise overclaim. MEASURED 2026-09-17:
  // KEY_PATTERN allows `..` INSIDE a name, where private-docs.ts's
  // safeSegment refuses it outright, so the script will deploy a key the
  // reader can never construct -- exactly the "document no tool will ever
  // find" its own header says the re-check exists to prevent.
  //
  // Left alone here on purpose. It is not a traversal (R2 keys are flat, the
  // namespace alternation admits no second `/`, and the arguments reach
  // execFileSync unshelled), it predates the `authoring/` namespace by three,
  // and tightening the writer is a behavior change that belongs to whoever
  // decides the two shapes should be one expression rather than to the issue
  // that added a word to an alternation. This test is what stops the gap from
  // being silent in the meantime.
  expect(keyVerdict('case-study/a..b.md')).toBe('accepted');
  expect(caseStudyDetailKey('a..b')).toBeNull();
  expect(narrativeKey('a..b')).toBeNull();
});
