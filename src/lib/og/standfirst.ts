import { z } from 'astro/zod';

/**
 * A post's or case study's line on its share card (#363). Separate from
 * `description`, which is written for search and runs to 500 characters; the
 * card's standfirst column fits about 140 at 30px. Optional, and a card
 * without one renders without one rather than truncating anything.
 *
 * Its own module so tests/og-cards.test.ts can assert the cap without loading
 * `astro:content`.
 */
export const standfirstSchema = z.string().max(140).optional();
