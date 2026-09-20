/**
 * The one Chrome the résumé sheet is allowed to render in.
 *
 * WHY THIS FILE EXISTS. The golden extraction beside the PDF is compared byte
 * for byte, and a line break in it is a layout decision some Chrome made. On
 * 2026-09-20 a skills line landed a word away from the right margin, this
 * machine's Chrome 153.0.8010.53 broke it one word earlier than the runner's
 * stable did, and the gate failed on a golden rendered here while both PDFs
 * said the same words. Every résumé change until then had been lucky rather
 * than reproducible: nothing had ever pinned the browser, so the golden was
 * only stable while no line sat near a boundary.
 *
 * `scripts/resume-sheet.mjs` records why puppeteer proper is not a dependency
 * here: it would pull a browser into every install of this repo to save about
 * eighty lines of CDP. That objection is to the install, not to the download,
 * so this uses `@puppeteer/browsers`, which ships no browser and fetches one
 * only when this script runs. `npm ci` stays the size it was.
 *
 * Chrome for Testing rather than whatever is on the machine, because it is the
 * only Chrome distribution with addressable, immutable versions. Regular Chrome
 * updates itself underneath you, which is precisely how the two sides drifted.
 *
 * THE PLATFORM IS ALSO A VARIABLE, and this paragraph has been wrong once in
 * each direction, so both readings are kept. It first said the pin could not
 * settle the platform question. It was then rewritten to say the platform was
 * not the variable at all, on one measurement: rendering here with the pinned
 * build reproduced the runner's line breaks exactly, including the break this
 * exercise started over. That measurement was real and the conclusion drawn
 * from it was too strong. A later change moved the same skills line back onto
 * the wrap boundary, and with the SAME pinned build on both sides, darwin/arm64
 * and linux/x64 broke it in different places again.
 *
 * What the pin actually buys is one fewer source of drift, not determinism.
 * A line sitting within a word of the right margin can still break differently
 * per platform, and the golden records line breaks, so THE GOLDEN COMES FROM
 * THE RUNNER when the two disagree: .github/workflows/resume-pdf.yml renders
 * what ships, on Linux. Expect to take three lines out of a failed `checks` run
 * whenever a résumé edit lands a line near the margin. Reproducing that locally
 * would mean rendering on Linux, which is the only thing that would close it.
 */
import {
  install,
  resolveBuildId,
  detectBrowserPlatform,
  computeExecutablePath,
  Browser,
} from '@puppeteer/browsers';
import { fileURLToPath } from 'node:url';

/**
 * Pinned to the Chrome for Testing stable build on 2026-09-20. This machine
 * was on 153.0.8010.53, one patch above it; the pin is what makes that
 * irrelevant rather than what matches it.
 *
 * Moving this number is a deliberate act with a cost: it re-renders the sheet,
 * moves the golden, and therefore needs RESUME_PDF_CONTRACT_VERSION bumped in
 * the same change, the same as any other change to what the sheet says.
 */
export const CHROME_VERSION = '153.0.8010.52';

/** Gitignored, and deliberately inside the repo so CI can cache one path. */
export const CACHE_DIR = fileURLToPath(new URL('../.chrome', import.meta.url));

/** Where the pinned build lands, whether or not it has been fetched yet. */
export function pinnedChromePath() {
  const platform = detectBrowserPlatform();
  if (!platform) return undefined;
  return computeExecutablePath({
    browser: Browser.CHROME,
    buildId: CHROME_VERSION,
    cacheDir: CACHE_DIR,
  });
}

async function main() {
  const platform = detectBrowserPlatform();
  if (!platform) throw new Error('no supported browser platform detected');

  const buildId = await resolveBuildId(Browser.CHROME, platform, CHROME_VERSION);
  const installed = await install({
    browser: Browser.CHROME,
    buildId,
    cacheDir: CACHE_DIR,
    // The default prints a progress bar per chunk, which in a CI log is
    // thousands of lines saying the same thing.
    downloadProgressCallback: undefined,
  });

  process.stdout.write(`${installed.executablePath}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
