---
project: skill-mining
registry: npm
package: skill-mining
versionSource: package.json
bumpSites:
  - package.json:version
  - src/utils.js:HELP_TEXT
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

The version is embedded in the CLI's help output, not just `package.json`. Update the version
string inside `HELP_TEXT` in `src/utils.js` (the `SKILL MINING CLI vX.Y.Z` line) to match.

Two things make this the riskiest single-package release in the family:

- **Nothing enforces the second site.** No test asserts the help text matches `package.json`,
  so R4's re-read is the only thing between a bump and a CLI reporting the wrong version to
  every user. Grep `src/utils.js` for the *old* version before committing — finding zero hits
  is the check.
- **The bump edits executable source, not metadata.** `src/utils.js` is real JavaScript. A
  malformed edit inside `HELP_TEXT` — an unescaped backtick, a broken template literal — still
  satisfies a textual version check while breaking the module at import. This is precisely why
  R6 re-runs the tests against the post-bump tree; the pre-bump run proves nothing about the
  file you just hand-edited.

Publishing uses a **repo-scoped** `NPM_TOKEN` (this workflow has no protected environment), so
the precondition asserts its presence by exact name. The retired command checked nothing at all:
a deleted token surfaced only *after* the tag had landed, which is the expensive ordering (R8).
