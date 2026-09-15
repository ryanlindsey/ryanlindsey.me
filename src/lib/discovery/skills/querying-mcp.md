---
name: querying-mcp
description: Call this site's Model Context Protocol server. Use when you want structured tool access to the corpus rather than fetching pages.
---

# Querying the MCP server

This site runs a Model Context Protocol server at `https://mcp.ryanlindsey.me/mcp`, reachable over the `streamable-http` transport.

## Connect with no credential

Call `tools/list` against that endpoint with no `Authorization` header. It answers in full, with no credential required to see or call any tool it lists:

```sh
curl https://mcp.ryanlindsey.me/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## The public tools

- `get_contact`: how to reach Ryan Lindsey, and his working timezone.
- `get_resume`: the resume as JSON Resume, published markdown, or a short prose summary.
- `list_case_studies`: published case studies with descriptions and citation URLs.
- `get_case_study`: full markdown of one case study, by slug.
- `list_writing`: published posts with descriptions and citation URLs.
- `get_post`: full markdown of one post, by slug.
- `search_writing`: semantic search over the corpus; each result is a passage with a real, fetchable citation URL.
- `request_private_access`: explains the private tier and how to request a scoped token.

Call any of these with no token at all. They cover the published corpus in full.

## A bearer token unlocks more

A private tier exists beyond these public tools, reached by presenting a bearer token in the `Authorization` header. A connection that presents one gets back an `initialize` result naming whatever that token's scopes unlock, in addition to the public tools above.

Fetch `/auth.md` for how to ask for one. It explains the private tier in full and gives the address that issues tokens.
