# ryanlindsey.me

The code behind [ryanlindsey.me](https://ryanlindsey.me) — an Astro site on the Cloudflare
developer platform, with a remote MCP server at `mcp.ryanlindsey.me`.

Source-visible so you can see how it's built; not licensed for reuse.

## Layout

| Path                         | What                                                   |
| ---------------------------- | ------------------------------------------------------ |
| `src/`                       | The Astro site — pages, layouts, styles                |
| `workers/mcp/`               | The MCP server Worker                                  |
| `tests/`                     | Smoke tests, run against the real build inside workerd |
| `wrangler.jsonc`             | The site Worker (`ryanlindsey-me`)                     |
| `workers/mcp/wrangler.jsonc` | The MCP Worker (`ryanlindsey-me-mcp`)                  |

## Local development

```
npm install
npm run build
npx wrangler dev
```

Deploys run on Workers Builds from `main`; there is no deploy step in CI.
