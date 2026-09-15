// The hash input is the résumé's own source bytes, imported with Vite's `?raw`
// so it works in every bundle this module lands in. It deliberately does NOT go
// through getResume()/astro:content: this module is imported by
// src/pages/resume.pdf.ts, which the Cloudflare Vite plugin builds into the
// Worker rather than as part of Astro's SSR graph, and `astro:content` is an
// Astro-only virtual module. The raw file IS the serialized collection entry,
// so nothing is lost. A rename of the file breaks the build loudly rather than
// silently hashing something else.
import resumeSource from '../content/resume/ryan-lindsey.yaml?raw';
// The contract version and the keys it addresses live in their own module
// because scripts/resume-publish.mjs has to import them from a plain node
// process, and the `?raw` import above resolves only inside a bundle. That
// file's header carries the measurement. They are re-exported here so every
// existing caller keeps importing them from where it always has.
import { resumeSourceHash as hashResumeSource } from './resume-pdf-contract';

export {
  RESUME_ALIAS_KEY,
  RESUME_PDF_CONTRACT_VERSION,
  RESUME_PDF_HTTP_METADATA,
  resumePdfKey,
} from './resume-pdf-contract';

/**
 * ALL THAT IS LEFT OF THIS MODULE, and the deletion is the point.
 *
 * Until #186 this file rendered the résumé PDF at runtime: a Browser Run
 * renderer over `@cloudflare/puppeteer`, a KV manifest recording which bytes
 * matched which source hash, a best-effort KV lock bounding a burst of browser
 * sessions, and a daily cron to drive it. Roughly 700 lines, all of it there to
 * answer one question -- "has the input changed since we last rendered?" --
 * which git answers for free once the render happens on a commit.
 *
 * The PDF is a pure function of the commit: every input is repo content. So the
 * render moved to .github/workflows/resume-pdf.yml, and what is left here is the
 * hash, which the workflow and the Worker must agree on and which is therefore
 * the one piece that could not move with it.
 *
 * What the move bought, beyond the line count: the artifact is now gated by
 * tests (scripts/resume-gate.mjs) before it is published, where the runtime
 * render put it somewhere no test could see -- which is how a contact-free
 * eight-page PDF shipped and stayed shipped. See epic #180 for the measurements.
 */
export async function resumeSourceHash(source: string = resumeSource): Promise<string> {
  return await hashResumeSource(source);
}
