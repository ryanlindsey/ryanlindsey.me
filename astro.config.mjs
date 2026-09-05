// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://ryanlindsey.me',
  // Static-first: pages prerender by default; individual routes opt into
  // on-demand rendering with `export const prerender = false`.
  output: 'static',
  adapter: cloudflare({
    imageService: 'compile',
  }),
  // This project does not use Astro Sessions. Leaving this on would make the
  // adapter provision an unmanaged `SESSION` KV namespace at deploy time.
  session: false,
  vite: {
    plugins: [tailwindcss()],
  },
});
