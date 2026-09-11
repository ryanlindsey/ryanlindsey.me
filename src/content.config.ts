import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { glob } from 'astro/loaders';
import { IMPACTS, LIKELIHOODS } from './lib/governance/register';

// 02 §2: three pillars, fixed at launch. A post belongs to exactly one.
const pillar = z.enum(['agentic-engineering', 'org-scaling', 'building-in-the-open']);

const posts = defineCollection({
  loader: glob({ base: './src/content/posts', pattern: '**/*.mdx' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    publishedAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    pillar,
    // Series support from day one (02 §2): posts 1/3/4 form "Building in the open".
    series: z
      .object({
        name: z.string(),
        order: z.number().int().positive(),
      })
      .optional(),
    draft: z.boolean().default(false),
  }),
});

// 02 §4's fixed shape is enforced against the rendered page in
// tests/case-studies.test.ts, not here: the six sections live in the body and a
// collection schema only sees frontmatter. src/lib/case-study-shape.ts holds
// the list both the test and any future UI read from.
//
// No `pillar`. 02 §2 declares the three pillars for posts ("a post belongs to
// exactly one") and asks nothing of case studies, so extending the taxonomy
// here would be inventing one. `kicker` on the article template says
// "Case study", which is the fact a reader of /work/<slug> actually needs.
const caseStudies = defineCollection({
  loader: glob({ base: './src/content/caseStudies', pattern: '**/*.mdx' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    publishedAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    draft: z.boolean().default(false),
    // 03 §2 asks list_case_studies for org scale, domain and outcomes.
    // Optional, because the MCP tool is shipping before the content that
    // fills them and a required field would either block the tool or invite
    // a placeholder. An entry that omits one omits it in the tool output
    // too -- the gap is visible rather than papered over.
    orgScale: z.string().optional(),
    domain: z.string().optional(),
    outcomes: z.array(z.string()).optional(),
  }),
});

// Résumé data model (day 3, 02 §1): the one validated value every rendered
// format -- HTML, Markdown, JSON, PDF -- reads from, so "one commit updates
// every format atomically" is actually true rather than aspirational.
//
// A month has no day, so dates are YYYY-MM strings checked by regex, not
// `z.coerce.date()`: coercing invents a day, which then renders as an
// off-by-one month in some timezones. `meta.lastModified` is a full calendar
// date (YYYY-MM-DD) for the same reason, checked by its own regex.
//
// `resumeSchema` is exported so `src/lib/resume.ts` can infer the `Resume`
// type from it with `z.infer` instead of hand-writing a parallel interface,
// which would be a second source of truth.
const yearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'expected a YYYY-MM date');

// Education and projects are where a bare year is the honest value. A degree is
// remembered and stated by year ("2003-2007"), not by the month the registrar
// recorded, and a side project rarely has a month anyone would defend, so
// demanding YYYY-MM would force a made-up month into the data -- the same error
// as coercing a day onto a YYYY-MM string, which the comment above refuses to
// make. Work dates stay strict: a job does start in a known month.
const yearOrYearMonth = z
  .string()
  .regex(/^\d{4}(-(0[1-9]|1[0-2]))?$/, 'expected a YYYY or YYYY-MM date');

const isoDate = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'expected a YYYY-MM-DD date');

export const resumeSchema = z.object({
  basics: z.object({
    name: z.string(),
    label: z.string(),
    summary: z.string(),
    email: z.string().optional(),
    phone: z.string().optional(),
    url: z.string().optional(),
    location: z.object({
      city: z.string(),
      region: z.string(),
      countryCode: z.string(),
    }),
    // Defaults to [] rather than staying optional/undefined, same reasoning
    // as `work[].highlights` below: absence is valid data, not a build error.
    profiles: z
      .array(
        z.object({
          network: z.string(),
          username: z.string(),
          url: z.string(),
        }),
      )
      .default([]),
  }),
  work: z.array(
    z.object({
      name: z.string(),
      position: z.string(),
      location: z.string().optional(),
      startDate: yearMonth,
      endDate: yearMonth.optional(),
      summary: z.string().optional(),
      // A role with nothing extracted is valid data, not a build error --
      // 2026-09-06 role inventory: all eight current entries are [].
      highlights: z.array(z.string()).default([]),
      // The one extension to JSON Resume. Case-study slugs; the `x_` prefix
      // marks it as non-standard so /resume.json (Task 3) can strip it.
      x_artifacts: z.array(z.string()).optional(),
    }),
  ),
  education: z.array(
    z.object({
      institution: z.string(),
      area: z.string().optional(),
      studyType: z.string().optional(),
      startDate: yearOrYearMonth.optional(),
      endDate: yearOrYearMonth.optional(),
    }),
  ),
  skills: z.array(
    z.object({
      name: z.string(),
      keywords: z.array(z.string()),
    }),
  ),
  // Work Ryan owns outright, kept deliberately separate from `work`. Two
  // reasons, and the second is the structural one:
  //
  // 1. `work` is employment history. A business he founded is not employment,
  //    and filing it as though it were would blur a distinction a reader cares
  //    about.
  // 2. `workHistoryIssues()` requires exactly one `work` entry without an
  //    `endDate`, because exactly one job is current. An ongoing side business
  //    is a genuine second concurrent commitment, so putting it in `work` would
  //    force that invariant to be relaxed for a case it was never about. A
  //    separate section keeps the invariant meaning what it says.
  //
  // `projects` is a standard JSON Resume section, so machine consumers already
  // understand it. Defaults to [] on the same reasoning as `profiles` above:
  // absence is valid data, not a build error.
  projects: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        url: z.string().optional(),
        roles: z.array(z.string()).default([]),
        startDate: yearOrYearMonth.optional(),
        endDate: yearOrYearMonth.optional(),
        highlights: z.array(z.string()).default([]),
        // Same `x_` extension as `work[].x_artifacts`, and the reason this
        // section needed one: the Pixelsonly Racing case study had no entry to
        // hang off while `work` was the only place artifacts could be declared.
        x_artifacts: z.array(z.string()).optional(),
      }),
    )
    .default([]),
  meta: z.object({
    version: z.string(),
    lastModified: isoDate,
  }),
});

const resume = defineCollection({
  loader: glob({ base: './src/content/resume', pattern: '**/*.yaml' }),
  schema: resumeSchema,
});

// The governance artifacts (06 §2), both loaded from `governance/` at the repo
// root rather than from src/content/. They are published documents ABOUT this
// repository and are meant to be read next to it -- a reader who clones the
// source finds them at a path that says what they are, not filed under the
// site's content tree beside the posts.
//
// TWO COLLECTIONS OVER ONE DIRECTORY, split by extension, because they are
// different kinds of thing: the policy is prose with a body Astro renders, and
// the register is data with no body at all. A single collection would need a
// schema that is the union of both and a page that branched on which it got.
const governance = defineCollection({
  loader: glob({ base: './governance', pattern: '**/*.md' }),
  schema: z.object({
    title: z.string(),
    // Quoted in the frontmatter, and it has to be: Astro parses markdown
    // frontmatter as YAML 1.1, which resolves a bare `2026-09-11` to a Date and
    // would fail this regex. src/content/resume/ryan-lindsey.yaml quotes its
    // own `lastModified` for the same reason.
    updated: isoDate,
    summary: z.string(),
  }),
});

// The scales live in src/lib/governance/register.ts so the page's colour ramp
// and this schema read one ordered list rather than two copies of it.
const riskRegister = defineCollection({
  loader: glob({ base: './governance', pattern: '**/*.yaml' }),
  schema: z.object({
    title: z.string(),
    updated: isoDate,
    rows: z
      .array(
        z.object({
          id: z.string(),
          risk: z.string(),
          likelihood: z.enum(LIKELIHOODS),
          impact: z.enum(IMPACTS),
          mitigation: z.string(),
          owner: z.string(),
          lastReviewed: isoDate,
        }),
      )
      // A register with no rows is a file somebody emptied, not a system with no
      // risks. Failing the build is the right answer to that.
      .min(1),
  }),
});

export const collections = { posts, caseStudies, resume, governance, riskRegister };
