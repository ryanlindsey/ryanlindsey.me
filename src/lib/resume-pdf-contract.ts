/**
 * Where the résumé PDF lives, and the version that decides when it moves.
 *
 * WHY THIS IS NOT IN src/lib/resume-pdf.ts, where it used to be. That module
 * imports `@cloudflare/puppeteer` and the résumé YAML through Vite's `?raw`,
 * so it resolves only inside a bundle. scripts/resume-publish.mjs is a plain
 * node process, and issue #185 requires it to import the key rather than
 * recompute it, so that the workflow and the Worker cannot disagree about
 * where the object lives. MEASURED 2026-09-15 on node 24.18: importing
 * src/lib/resume-pdf.ts from node fails with `Unknown file extension ".yaml"`,
 * because node's resolver drops the `?raw` query and then meets a file
 * extension it has no loader for.
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
// constant is for. Note that no runtime input moved: src/lib/resume-pdf.ts
// renders `/resume?print` and nothing here imports the stamper or the sheet's
// stylesheet, so today the bump changes no deployed byte. It is made anyway,
// for the reason version 3's note gives about the Armature entry -- the golden
// moved, and the gate added in #184 requires the constant to move with it, so
// that once 05 publishes from the golden's own render the hash cannot point at
// bytes nobody can reproduce.
export const RESUME_PDF_CONTRACT_VERSION = 4;

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
