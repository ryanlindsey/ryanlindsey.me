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

export const collections = { posts, caseStudies };
