/**
 * Where the résumé PDF lives, and the version that decides when it moves.
 *
 * WHY THIS IS NOT IN src/lib/resume-pdf.ts, where it used to be. That module
 * imports the résumé YAML through Vite's `?raw`, so it resolves only inside a
 * bundle. scripts/resume-publish.mjs is a plain node process, and issue #185
 * requires it to import the key rather than recompute it, so that the workflow
 * and the Worker cannot disagree about where the object lives. MEASURED
 * 2026-09-15 on node 24.18: importing src/lib/resume-pdf.ts from node fails
 * with `Unknown file extension ".yaml"`, because node's resolver drops the
 * `?raw` query and then meets a file extension it has no loader for.
 *
 * It also imported `@cloudflare/puppeteer` when that measurement was taken,
 * which was the other half of the reason and is no longer true: #186 deleted
 * the runtime renderer and the dependency with it. The `?raw` import alone
 * still makes the split necessary, so nothing here moves back.
 *
 * So the addressing moved here, where nothing is imported at all, and
 * src/lib/resume-pdf.ts re-exports it. Both readers run the same code. The
 * alternative -- a second copy of the hash construction in the script -- is
 * the one thing the issue rules out, because the two copies agree right up
 * until the day one of them is edited.
 *
 * `tests/resume-publish.test.ts` asserts the two readers land on one key.
 */

/**
 * Bump when src/pages/resume.astro's rendered contract changes in a way that
 * should produce a different PDF from identical résumé data -- a layout change,
 * a new section, different print CSS.
 *
 * This constant exists because the hash is taken over the résumé INPUTS, not
 * over the rendered HTML. Hashing the HTML would look more correct and be
 * badly wrong: the rendered page carries content-hashed asset URLs
 * (/_astro/*.css) that change on every deploy, so the PDF would regenerate
 * every deploy forever and browser-hours would scale with deploys instead of
 * with content.
 */
// 2 since 2026-09-13: the redesign (design 1k, issue #108) rebuilt the page
// around a masthead grid and a section rail and added print rules for both, so
// identical résumé data renders a different sheet. Without this bump the
// deployed manifest keeps pointing at bytes rendered from the old page, and
// /resume.pdf would go on serving the pre-redesign PDF until the YAML next
// changed -- the exact stale-cache failure this constant exists to prevent.
//
// 3 since 2026-09-13 (issue #141): the sheet gained a contact block that exists
// only in print, and the location line became a link whose printed URL suffix
// is suppressed. Both change what identical résumé data renders.
//
// The YAML changed in the same commit, so the hash would have moved without
// this. Bumped anyway, because the two are independent: reverting the Armature
// entry later would restore the old hash while the page still renders the new
// sheet, and the manifest would then point at bytes nobody can reproduce.
// 4 since 2026-09-15 (issue #184): the running foot moved out of Chrome's
// footer template and into the page. That template's document does not load
// webfonts at all, so every glyph of the foot had been drawing in a host system
// serif rather than the sheet's mono face -- visible in the text layer as
// `R YA N` in the foot against `R Y A N` in the docline above it, because a
// proportional face kerns the RY pair and IBM Plex Mono has none to apply. Only
// `n / total` is still drawn there, because `counter(page)` outside an `@page`
// margin box evaluates to 0 in Chrome.
//
// Identical résumé data therefore renders a different sheet, which is what this
// constant is for. When the bump was made it moved no runtime input:
// src/lib/resume-pdf.ts still rendered `/resume?print` and nothing here
// imported the stamper or the sheet's stylesheet, so it changed no deployed
// byte. It was made anyway, for the reason version 3's note gives about the
// Armature entry -- the golden moved, and the gate added in #184 requires the
// constant to move with it, so that once 05 publishes from the golden's own
// render the hash cannot point at bytes nobody can reproduce.
//
// Since #186 that caveat is retired rather than merely stale: there is no
// second renderer left to disagree with the golden. The only writer is
// .github/workflows/resume-pdf.yml, publishing what scripts/resume-sheet.mjs
// rendered and scripts/resume-gate.mjs checked, so a bump here now moves the
// key that workflow publishes to and the key /resume.pdf reads from together.
// A bump with no matching golden fails the `contract` check in the gate.
// 5 since 2026-09-15: a visual review of the rendered PDF cut the credit line
// from the bottom band, and the `.foot` element that drew it is gone. The page
// number stays, in the position it already had, so the band is one line rather
// than two and identical résumé data renders a different sheet.
//
// Unlike version 4's bump this one moves live bytes. Since #186 this constant
// picks the key .github/workflows/resume-pdf.yml publishes to and the key
// /resume.pdf reads from, so without it the workflow would read a hash it has
// already seen, skip the upload, and go on serving the sheet with the credit
// line on it.
export const RESUME_PDF_CONTRACT_VERSION = 5;

const encoder = new TextEncoder();

/**
 * SHA-256 over the contract version and the résumé source bytes, hex-encoded.
 * Stable across deploys by construction: nothing in the input moves unless the
 * résumé content or the page's contract does.
 *
 * The source is a required argument here and carries a default in
 * src/lib/resume-pdf.ts, which is the module that can reach the file. Callers
 * outside a bundle pass the bytes they read themselves.
 *
 * `crypto.subtle` rather than node:crypto, because this module is imported by
 * the Worker as well: it is a global in workerd and in node since 20, and
 * naming the node module would not resolve on the Worker side.
 */
export async function resumeSourceHash(source: string): Promise<string> {
  const input = `resume-pdf/v${RESUME_PDF_CONTRACT_VERSION}\n${source}`;
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function resumePdfKey(hash: string): string {
  return `resume/${hash}.pdf`;
}

/**
 * The stable name, written with the same bytes as the content-addressed key.
 * An alias rather than a redirect because R2 has no such thing, and because a
 * reader that wants "the current sheet" should not have to learn a hash first.
 *
 * IT IS ALSO WHAT /resume.pdf FALLS BACK TO, which is why it moved here from
 * scripts/resume-publish.mjs in #186. Until then the script was its only
 * reader and owning the constant was reasonable; now the Worker reads it too,
 * and a Worker cannot import a `.mjs` script's export. Both readers take it
 * from here for the reason this module's header gives about the key itself:
 * two spellings agree right up until the day one of them is edited, and the
 * failure would be a route falling back to a key nobody writes.
 */
export const RESUME_ALIAS_KEY = 'resume/latest.pdf';

/**
 * The response metadata the stored object carries. It is in one place because
 * it was set in two: `regenerateResumePdf` passed it to `R2.put` and
 * scripts/resume-publish.mjs turned it into wrangler flags, as literals in
 * both until #185 -- a duplicate nothing would have caught, because a sheet
 * served as an attachment rather than inline, or as the wrong media type,
 * renders as a download prompt and no test in this repo sees the headers.
 *
 * #186 deleted the first of those writers, so the publish script is now the
 * only one that stamps an object. The constant stays shared rather than
 * folding back into the script, because /resume.pdf and tests/resume-pdf.test.ts
 * both assert these exact values on the response the stamp produces.
 *
 * `contentDisposition` names the file a visitor saves, which is why it is a
 * person's name and not the content-addressed key.
 */
export const RESUME_PDF_HTTP_METADATA = {
  contentType: 'application/pdf',
  cacheControl: 'public, max-age=300',
  contentDisposition: 'inline; filename="ryan-lindsey-resume.pdf"',
} as const;
