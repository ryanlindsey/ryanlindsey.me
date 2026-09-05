import { defineCollection, z } from 'astro:content';
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

// Created now so the loader and generated types exist. Day 3 extends this with
// the fixed case-study shape from 02 §4.
const caseStudies = defineCollection({
  loader: glob({ base: './src/content/caseStudies', pattern: '**/*.mdx' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    publishedAt: z.coerce.date(),
    draft: z.boolean().default(false),
  }),
});

export const collections = { posts, caseStudies };
