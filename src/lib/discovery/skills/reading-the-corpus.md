---
name: reading-the-corpus
description: Read this site as machine-readable documents. Use when you need the published writing, case studies or resume as markdown or JSON rather than HTML.
---

# Reading the corpus

This site publishes a machine-readable copy of everything it makes public. Fetch documents directly instead of parsing HTML.

## Start at the index

Fetch `/llms.txt` first. It is the curated index: a short summary, then linked sections for the resume, the case studies, the posts and the site's own interactive surfaces, each entry described in one line.

Fetch `/llms-full.txt` when the whole corpus is more useful than one entry at a time. It carries every published document's markdown in one file, so grounding a query costs one fetch instead of one per page.

## Every article and case study has a markdown twin

Every published post and case study is reachable two ways: as an HTML page, and as markdown at the same path with `.md` appended. `/writing/<slug>` and `/writing/<slug>.md` describe the same document; read the second one.

The extensionless path also negotiates. Send `Accept: text/markdown` on `/writing/<slug>` and the response is the same markdown document, not the HTML page:

```sh
curl -H 'Accept: text/markdown' https://ryanlindsey.me/writing/<slug>
```

An ordinary browser `Accept` header gets the HTML page from the same URL. Either route to the markdown works; the `.md` suffix needs no negotiation and is the more predictable of the two.

## The resume

Fetch `/resume.json` for the resume as JSON Resume, verbatim: the schema itself, with nothing site-specific wrapped around it.

## New writing

Fetch `/rss.xml` or `/feed.json` to follow what publishes next. Both carry the same set of entries in their own format; use whichever your tooling already reads.
