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

> ## ✅ CONFORMANT — migrated 2026-07-20
>
> The publish job is bound to the `npm-publish` environment (required reviewer:
> voodootikigod), the repo-scoped `NPM_TOKEN` is deleted, and publishing uses OIDC
> trusted publishing. **First successful OIDC publish: v1.10.0 on 2026-07-20**,
> approved by voodootikigod, provenance attestation verified on the registry — Step 8's
> trusted-publisher question is answered by that record.
>
> Note: the environment currently allows admin bypass of review. R1 forbids using it,
> but it is not enforced by config — tighten in the environment settings if desired.

`package.json` is the only bump site. The CLI's help output and `--version` flag both derive
the version from `package.json` at runtime (`PACKAGE_VERSION` in `src/utils.js`, read via
`createRequire`), and a test asserts `HELP_TEXT` contains the `package.json` version — so a
bump cannot leave the CLI reporting a stale version. The former second site
(`src/utils.js:HELP_TEXT` as a hand-edited string) was retired on 2026-07-20.

The publish workflow pins Node 24 and upgrades npm before publishing — OIDC trusted
publishing needs npm >= 11.5.1, and Node's bundled npm can lag behind that. If the
publish step ever fails with an auth error despite a green gate, check the npm version
in the run log before suspecting the trusted-publisher config.
