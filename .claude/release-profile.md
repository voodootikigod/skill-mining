---
project: skill-mining
registry: npm
package: skill-mining
versionSource: package.json
bumpSites:
  - package.json:version
preconditions:
  - npm test
landing: direct
publishTrigger: tag
publishEnvironment: npm-publish
publishWorkflow: .github/workflows/publish.yml
verify:
  - npm view skill-mining@{{version}} version
  - '[ "$(npm view skill-mining dist-tags.latest)" = "{{version}}" ]'
---

> ## ⛔ NOT YET CONFORMANT — `/release` will refuse this repo
>
> Audited 2026-07-16. The Standard requires a human-approved deployment and OIDC trusted
> publishing. This repo fails Step 1 on:
>
> - **No environment gate.** `publish.yml`'s publish job has no `environment:` key, so
>   nothing pauses for a reviewer.
> - **Live repo-scoped `NPM_TOKEN`.** Readable by every job in the repo.
>
> **Migration (a separate change from this profile — do not do it during a release):**
>
> 1. Create a `npm-publish` environment with at least one required reviewer.
> 2. Add `environment: npm-publish` to the publish job.
> 3. Configure trusted publishing for `skill-mining` on npmjs.com.
> 4. Delete the repo-scoped `NPM_TOKEN` secret.
>
> The npmjs.com trusted-publisher configuration cannot be automated from here — a human must do
> it in the registry UI. Delete the secret only *after* it is configured, or the next publish
> fails with no credential and no fallback.

`package.json` is the only bump site. The CLI's help output and `--version` flag both derive
the version from `package.json` at runtime (`PACKAGE_VERSION` in `src/utils.js`, read via
`createRequire`), and a test asserts `HELP_TEXT` contains the `package.json` version — so a
bump cannot leave the CLI reporting a stale version. The former second site
(`src/utils.js:HELP_TEXT` as a hand-edited string) was retired on 2026-07-20.

Publishing uses a **repo-scoped** `NPM_TOKEN` (this workflow has no protected environment), so
the precondition asserts its presence by exact name. The retired command checked nothing at all:
a deleted token surfaced only *after* the tag had landed, which is the expensive ordering (R8).
