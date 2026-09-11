# Changelog

## [1.10.0](https://github.com/ryanlindsey/ryanlindsey.me/compare/ryanlindsey-me-v1.9.2...ryanlindsey-me-v1.10.0) (2026-09-11)


### Features

* **agent-intel:** classify agent traffic, record datapoints and notify on high intent ([#60](https://github.com/ryanlindsey/ryanlindsey.me/issues/60)) ([e80f7dc](https://github.com/ryanlindsey/ryanlindsey.me/commit/e80f7dc29a16d9631a50b18d04fdc7405c99a4ff))

## [1.9.2](https://github.com/ryanlindsey/ryanlindsey.me/compare/ryanlindsey-me-v1.9.1...ryanlindsey-me-v1.9.2) (2026-09-11)


### Bug Fixes

* **evals:** a failed recording must not destroy the run ([#58](https://github.com/ryanlindsey/ryanlindsey.me/issues/58)) ([8192d6a](https://github.com/ryanlindsey/ryanlindsey.me/commit/8192d6a9115c0f1e646cb275b8490ff6fe829426))

## [1.9.1](https://github.com/ryanlindsey/ryanlindsey.me/compare/ryanlindsey-me-v1.9.0...ryanlindsey-me-v1.9.1) (2026-09-10)


### Bug Fixes

* **evals:** pace the suite against the wholesale rate limit ([#56](https://github.com/ryanlindsey/ryanlindsey.me/issues/56)) ([f51a8bf](https://github.com/ryanlindsey/ryanlindsey.me/commit/f51a8bf3f7379ebc682ad38ea1afff66765a7b97))

## [1.9.0](https://github.com/ryanlindsey/ryanlindsey.me/compare/ryanlindsey-me-v1.8.2...ryanlindsey-me-v1.9.0) (2026-09-10)


### Features

* **chat:** add grounded chat with cited, streamed answers ([#50](https://github.com/ryanlindsey/ryanlindsey.me/issues/50)) ([f672a07](https://github.com/ryanlindsey/ryanlindsey.me/commit/f672a0755d0dc1d83c18743d211cb3beb1149c2f))


### Bug Fixes

* **evals:** give a full run headroom, retry a rate-limited call, and correct the BYOK claim ([#55](https://github.com/ryanlindsey/ryanlindsey.me/issues/55)) ([85411c6](https://github.com/ryanlindsey/ryanlindsey.me/commit/85411c63f9bfea6bffb73c16a3d58db974ea44c5))
* **evals:** parse the MCP response by content-type, not by its first line ([#52](https://github.com/ryanlindsey/ryanlindsey.me/issues/52)) ([806c514](https://github.com/ryanlindsey/ryanlindsey.me/commit/806c5144b0a2bb7e9c1ac87c4e8c42e7cd8ba42d))
* **evals:** repair the three defects the first full eval run exposed ([#54](https://github.com/ryanlindsey/ryanlindsey.me/issues/54)) ([6d984fb](https://github.com/ryanlindsey/ryanlindsey.me/commit/6d984fb144cb87f5dea8ec3e6c28ccdafd1bdbf1))
* **scripts:** stop minting tokens with a signing key the CLI cannot read ([#48](https://github.com/ryanlindsey/ryanlindsey.me/issues/48)) ([f62f476](https://github.com/ryanlindsey/ryanlindsey.me/commit/f62f4767271793f9c91b492328248368364a0b81))


### Documentation

* **evals:** mint the eval token for a day, and set it per command ([#53](https://github.com/ryanlindsey/ryanlindsey.me/issues/53)) ([f210a63](https://github.com/ryanlindsey/ryanlindsey.me/commit/f210a63cd20f9d5314b10383f8b29b98a80b6e3c))
* **evals:** say that the token must be minted and used in one shell ([#51](https://github.com/ryanlindsey/ryanlindsey.me/issues/51)) ([0739f07](https://github.com/ryanlindsey/ryanlindsey.me/commit/0739f07c51d8a46727f48ae913f6cf3870fc8d5a))

## [1.8.2](https://github.com/ryanlindsey/ryanlindsey.me/compare/ryanlindsey-me-v1.8.1...ryanlindsey-me-v1.8.2) (2026-09-10)


### Bug Fixes

* **tier:** page through every campaign and stop the audience lookup at its match ([#42](https://github.com/ryanlindsey/ryanlindsey.me/issues/42)) ([1505547](https://github.com/ryanlindsey/ryanlindsey.me/commit/150554718f9b38f2d259e733703082523d43088c))

## [1.8.1](https://github.com/ryanlindsey/ryanlindsey.me/compare/ryanlindsey-me-v1.8.0...ryanlindsey-me-v1.8.1) (2026-09-10)


### Performance

* **db:** make the audit trail's grant_jti index partial ([#41](https://github.com/ryanlindsey/ryanlindsey.me/issues/41)) ([d88dc75](https://github.com/ryanlindsey/ryanlindsey.me/commit/d88dc75a9b15b864ffaecc1590576ab7038a38bd))

## [1.8.0](https://github.com/ryanlindsey/ryanlindsey.me/compare/ryanlindsey-me-v1.7.0...ryanlindsey-me-v1.8.0) (2026-09-10)


### Features

* **tier:** add an isScope guard and correct the token format's comments ([#40](https://github.com/ryanlindsey/ryanlindsey.me/issues/40)) ([84703da](https://github.com/ryanlindsey/ryanlindsey.me/commit/84703da5d399213bd63c440a19bcb4029246c235))

## [1.7.0](https://github.com/ryanlindsey/ryanlindsey.me/compare/ryanlindsey-me-v1.6.0...ryanlindsey-me-v1.7.0) (2026-09-10)


### Features

* **writing:** add the terminal setup post as a draft ([#39](https://github.com/ryanlindsey/ryanlindsey.me/issues/39)) ([21ffae5](https://github.com/ryanlindsey/ryanlindsey.me/commit/21ffae53416c50acdc7db3872a360cb20530c4ee))

## [1.6.0](https://github.com/ryanlindsey/ryanlindsey.me/compare/ryanlindsey-me-v1.5.0...ryanlindsey-me-v1.6.0) (2026-09-09)


### Features

* **tier:** ship the scoped-token private tier and the fit engine ([#37](https://github.com/ryanlindsey/ryanlindsey.me/issues/37)) ([0128846](https://github.com/ryanlindsey/ryanlindsey.me/commit/0128846d46618d7b2da312a71247d6bf4b2b1983))

## [1.5.0](https://github.com/ryanlindsey/ryanlindsey.me/compare/ryanlindsey-me-v1.4.1...ryanlindsey-me-v1.5.0) (2026-09-08)


### Features

* **resume:** fill the Weedmaps decade and close the content-track gate ([#26](https://github.com/ryanlindsey/ryanlindsey.me/issues/26)) ([63dbb9f](https://github.com/ryanlindsey/ryanlindsey.me/commit/63dbb9fb9691dd2a29ab0fab65ea28eab2637491))


### Bug Fixes

* **mcp:** enforce rate limits in a Durable Object, not the ratelimits binding ([#31](https://github.com/ryanlindsey/ryanlindsey.me/issues/31)) ([444a636](https://github.com/ryanlindsey/ryanlindsey.me/commit/444a63640cee635e09143a71a5a3c659234b6501))
* **mcp:** read published documents over a SITE service binding ([#30](https://github.com/ryanlindsey/ryanlindsey.me/issues/30)) ([9bcbb0a](https://github.com/ryanlindsey/ryanlindsey.me/commit/9bcbb0ada8274fc5d1f387a385c573f71b6bc6ce)), closes [#28](https://github.com/ryanlindsey/ryanlindsey.me/issues/28)

## [1.4.1](https://github.com/ryanlindsey/ryanlindsey.me/compare/ryanlindsey-me-v1.4.0...ryanlindsey-me-v1.4.1) (2026-09-07)


### Dependencies

* bump the all group with 4 updates ([#24](https://github.com/ryanlindsey/ryanlindsey.me/issues/24)) ([8640867](https://github.com/ryanlindsey/ryanlindsey.me/commit/8640867590755ad6ebccd1955196de1b7c3fe7ee))

## [1.4.0](https://github.com/ryanlindsey/ryanlindsey.me/compare/ryanlindsey-me-v1.3.0...ryanlindsey-me-v1.4.0) (2026-09-07)


### Features

* **work:** publish the first two case studies ([#20](https://github.com/ryanlindsey/ryanlindsey.me/issues/20)) ([cddddb9](https://github.com/ryanlindsey/ryanlindsey.me/commit/cddddb960479eecb6dea7ac0cb8fd0c0b9606ddf))

## [1.3.0](https://github.com/ryanlindsey/ryanlindsey.me/compare/ryanlindsey-me-v1.2.0...ryanlindsey-me-v1.3.0) (2026-09-07)


### Features

* **resume:** complete the resume pipeline, agent-publishing surfaces, and corpus ([#18](https://github.com/ryanlindsey/ryanlindsey.me/issues/18)) ([dafbf38](https://github.com/ryanlindsey/ryanlindsey.me/commit/dafbf38fac6949e4b1aeb9fdea8a2a92bece7130))

## [1.2.0](https://github.com/ryanlindsey/ryanlindsey.me/compare/ryanlindsey-me-v1.1.1...ryanlindsey-me-v1.2.0) (2026-09-06)


### Features

* **work:** add the /work case-study route and enforce the 02 §4 shape ([#16](https://github.com/ryanlindsey/ryanlindsey.me/issues/16)) ([72e283e](https://github.com/ryanlindsey/ryanlindsey.me/commit/72e283e025218fd5ca8e997a4255565967901976))

## [1.1.1](https://github.com/ryanlindsey/ryanlindsey.me/compare/ryanlindsey-me-v1.1.0...ryanlindsey-me-v1.1.1) (2026-09-06)


### Build System

* record reviewed npm install-script approvals ([#14](https://github.com/ryanlindsey/ryanlindsey.me/issues/14)) ([59b5825](https://github.com/ryanlindsey/ryanlindsey.me/commit/59b5825bf85697770586c9d0094fe275c9fd2eba))

## [1.1.0](https://github.com/ryanlindsey/ryanlindsey.me/compare/ryanlindsey-me-v1.0.0...ryanlindsey-me-v1.1.0) (2026-09-05)


### Features

* **design:** add the design system, site shell, and article template ([#10](https://github.com/ryanlindsey/ryanlindsey.me/issues/10)) ([edaa0d2](https://github.com/ryanlindsey/ryanlindsey.me/commit/edaa0d21e91c21edb3c876e15195c297f92a3c98))
* **mcp:** enable Workers logs and traces on the MCP Worker ([#12](https://github.com/ryanlindsey/ryanlindsey.me/issues/12)) ([853111d](https://github.com/ryanlindsey/ryanlindsey.me/commit/853111dd36a6900da3267a97013d8e95384ad9cf))

## 1.0.0 (2026-09-05)


### Features

* **platform:** scaffold the site and MCP Workers on Cloudflare ([#1](https://github.com/ryanlindsey/ryanlindsey.me/issues/1)) ([30b716e](https://github.com/ryanlindsey/ryanlindsey.me/commit/30b716ea0615aa66d01eb103a275ab6b2f648e9c))


### Build System

* **deps:** Bump actions/checkout from 5 to 7 ([#2](https://github.com/ryanlindsey/ryanlindsey.me/issues/2)) ([04799f1](https://github.com/ryanlindsey/ryanlindsey.me/commit/04799f10689747f25ae7c0a0a6e10924d35412b0))
* **deps:** Bump actions/setup-node from 5 to 7 ([#3](https://github.com/ryanlindsey/ryanlindsey.me/issues/3)) ([297a19b](https://github.com/ryanlindsey/ryanlindsey.me/commit/297a19bc5dfec88c3759eaa9e1c44ce37ee10e9e))
* **mcp:** give the MCP Worker its own manifest so Workers Builds can build it ([#6](https://github.com/ryanlindsey/ryanlindsey.me/issues/6)) ([1d43418](https://github.com/ryanlindsey/ryanlindsey.me/commit/1d43418e2cc584edbfded397a5bf2ab773e9d7b5))
* **mcp:** track the MCP server's advertised version with release-please ([#9](https://github.com/ryanlindsey/ryanlindsey.me/issues/9)) ([ef5fc05](https://github.com/ryanlindsey/ryanlindsey.me/commit/ef5fc0555d57ba977a8eb418598573f2f944ff2d))
