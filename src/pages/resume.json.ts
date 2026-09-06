import type { APIRoute } from 'astro';
import { getResume } from '../lib/resume-collection';

// Day 3 Task 3 (02 §1): "JSON Resume schema verbatim -- machine-readable,
// standard." Static output: this route is a pure function of the same
// committed résumé data /resume and /resume.md read, so it prerenders like
// every other page -- Task 5 owns introducing the first on-demand route, and
// this is not it.
//
// Astro's static build writes only the Response BODY to disk
// (dist/client/resume.json); the header set below does not survive into the
// deployed artifact. The served Content-Type instead comes from Cloudflare's
// asset server, whose default mime lookup for `.json` omits `charset=utf-8`
// -- see public/_headers for the override that makes the deployed response
// match this file's own header exactly.
export const prerender = true;

const JSON_RESUME_SCHEMA_URL =
  'https://raw.githubusercontent.com/jsonresume/resume-schema/v1.0.0/schema.json';

/**
 * Strips every `x_`-prefixed key, at any depth, from an arbitrarily nested
 * JSON-compatible value. `x_artifacts` is this site's own extension (see
 * content.config.ts) and a consumer validating against the JSON Resume
 * schema should never meet it -- stripping by prefix rather than naming
 * `x_artifacts` explicitly means a future `x_`-prefixed extension is handled
 * here without anyone having to remember to edit this file.
 */
function stripXKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripXKeys);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !key.startsWith('x_'))
        .map(([key, entryValue]) => [key, stripXKeys(entryValue)]),
    );
  }
  return value;
}

export const GET: APIRoute = async () => {
  const resume = await getResume();
  const stripped = stripXKeys(resume) as Record<string, unknown>;
  // $schema first, per JSON Resume convention -- object spread after a
  // literal key preserves insertion order, so this does not need a manual
  // key-ordering step.
  const jsonResume = { $schema: JSON_RESUME_SCHEMA_URL, ...stripped };

  return new Response(JSON.stringify(jsonResume, null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
