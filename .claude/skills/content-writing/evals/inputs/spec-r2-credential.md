# Spec: a post on scoping a CI credential to one R2 bucket

> use the `/house-style` skill for when writing prose

## Why

The résumé workflow is the only thing in this repository's CI that authenticates to Cloudflare, and the credential it holds was meant to reach one bucket and nothing else. Its first version, shipped in #185, called `wrangler r2 object` with a bucket-scoped R2 token and never once succeeded. Issue #205 diagnosed it across four failed runs, #206 fixed it by moving to the S3 API with the AWS CLI, and #207 corrected two of #206's explanations and a comment about AWS checksum settings. The reasoning is recorded only in those issue bodies, `CLAUDE.md` and the comments in `scripts/resume-publish.mjs`, which nobody outside this repository will read.

The post turns that record into something portable: why an object-level R2 token fails over the REST API, why keeping wrangler costs least privilege, and a workflow step another engineer can copy.

## What changes

One new post in `src/content/posts/`, pillar `building-in-the-open`, series `Building in the open`, order 4. Working title "Scoping a CI credential to one R2 bucket", working slug `scoping-a-ci-credential-to-one-r2-bucket`. The final title states the capability and never a defect, and is settled while drafting.

### Thesis

A `403` with `10000 Authentication error` reads as a bad token, and on R2 it can be a good token presented to the wrong API. Object-level R2 permissions are honored only by the S3-compatible API; wrangler speaks the Cloudflare REST API. The permission wrangler can use, Admin Read & Write, cannot be scoped to a bucket, so least privilege and wrangler cannot both be had, and the fix is to change the client rather than widen the credential.

### Structure

1. **The run that never succeeded.** Open on the defect. The workflow merged 2026-09-15 12:04 and failed every run in its first step with `403` and `10000 Authentication error`. Four runs went to the token value, whitespace, bucket scope and account.
2. **Why the credential had to be narrow.** The private tier is a partition rather than a filter; a CI credential that could reach `ryanlindsey-me-private` would be the first thing in the repository holding a reference to it.
3. **The diagnostic job.** A temporary job that read the stored secret in the runner and asked five questions with it. Quote the output. `r2/buckets` failing is what ruled out scope.
4. **The one line of documentation.** Quote r2/api/tokens. Explain the three ways into R2: binding, S3 endpoint, REST API.
5. **Two repairs.** Admin Read & Write keeps wrangler and loses bucket scope; the S3 pair keeps the scope and needs a new client. The AWS CLI is already on the runner.
6. **What the fix taught after it shipped.** #207's corrections: an R2 token is a Cloudflare API token; the rejected alternative was Admin Read & Write, not a custom token; the checksum settings are required, not a precaution (aws-cli#9214). The Access Key ID and Secret are a projection of one token, so revoking it breaks CI.
7. **The step to copy.** The workflow step, the checksum environment variables, and the probe that throws on anything but an exact 404.

### Sources

Every factual claim is dated and comes from one of two places.

- **This repository.** #205's diagnostic output (2026-09-15), #206 and #207, the `CLAUDE.md` section "The one credential in CI", `scripts/resume-publish.mjs` and its test fixtures, `.github/workflows/resume-pdf.yml`.
- **Cloudflare's documentation, reread while drafting.** r2/api/tokens for the permission rule and the Access Key derivation; the R2 troubleshooting page for the 401 versus 403 shapes. Each is cited by link.

## What does not change

- No code, configuration, test or workflow changes. This is content only.
- Secret values, the token id and any account-specific identifier beyond what is already committed do not appear.
- The private bucket's contents are not described beyond "documents a scoped token unlocks". No audience or campaign is named.

## Testing

- Drafted under the `house-style` skill, unwrapped, and `check-prose.mjs` clean on the new file.
- `npm run check`, then `npm test` with the file staged.
- A read against the exclusions above, done by hand.

## Scope

One branch and one pull request, titled `feat(writing): publish the r2 credential post` from the first commit. No epic and no child issues.

- [ ] Draft the post with `draft: true` and run the checks above.
- [ ] Open the pull request and request review against the Workers Builds preview alias.
- [ ] Revise in further commits.
- [ ] On approval, a final commit flips `draft: false` and sets `publishedAt`.
