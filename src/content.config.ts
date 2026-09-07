import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { glob } from 'astro/loaders';

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

// Education is the one place a bare year is the honest value. A degree is
// remembered and stated by year ("2003-2007"), not by the month the registrar
// recorded, so demanding YYYY-MM here would force a made-up month into the
// data -- the same error as coercing a day onto a YYYY-MM string, which the
// comment above refuses to make. Work dates stay strict: a job does start in a
// known month.
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
  meta: z.object({
    version: z.string(),
    lastModified: isoDate,
  }),
});

const resume = defineCollection({
  loader: glob({ base: './src/content/resume', pattern: '**/*.yaml' }),
  schema: resumeSchema,
});

export const collections = { posts, caseStudies, resume };
