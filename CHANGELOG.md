# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

## [1.10.0] — 2026-07-20

### Added
- Deterministic grounding pre-check (`src/grounding.js`): every Gate B review round verifies the authored skill's cited paths and npm-script references against the real survey; code-verified defects veto a reviewer SHIP and feed the fix prompt.
- Gate A 3-skeptic escalation for risk-relevant candidates (security/auth/deploy/payment/migration keywords, word-anchored): any-REJECT veto, 2-of-3 build-like majority, splits defer.
- Truncation detection on every provider response (Anthropic `stop_reason`, OpenAI `finish_reason`, Gemini `finishReason`) — a truncated artifact now fails closed instead of shipping cut off.
- CLI: `--version`/`-v`, `--out-dir <dir>` (target any harness skills tree; recorded in the sidecar), `--dry-run` (post-dedupe ledger preview, writes nothing; refused in partial modes).
- Bounded parallelization of all per-item pipeline loops (order-preserving `mapLimit`): ecosystem searches ×4, authoring ×3, dedupe decisions ×4, Gate B ×2, agent gate ×3.
- Injectable LLM caller seam (`llmConfig.caller`) and test coverage for the gates, grounding, and fingerprinting (suite grew from 41 to 137 tests).
- OIDC trusted publishing: the publish workflow is gated behind the reviewed `npm-publish` environment, tokenless, with provenance.

### Fixed
- Gate B fix prompts now include the repo ground truth, test task, and grounding findings; no fix call is wasted on the final round; lint-repaired markdown is re-grounded before shipping.
- Score phase dedupes model output by name (a duplicate previously aborted the whole run at report lint).
- Partial-mode policy check requires a Gate B SHIP verdict (with v1.6.x legacy-format compatibility) instead of a substring match.
- Legacy no-sidecar reports recover Deferred/Rejected ledger rows instead of silently dropping them.
- Team manifest is composed as structured data with validated handoff targets and personas, rendered deterministically.
- `isSafePackageRef` accepts scoped `@org/repo[@version]` references; `--flag=value` parsing preserves values containing `=`.
- OpenAI reasoning models use `max_completion_tokens` (defaults refreshed to `gpt-5`/`gpt-5-mini`).
- Version is single-sourced from `package.json` at runtime (`HELP_TEXT` and `--version`), retiring the hand-edited bump site.

### Changed
- Docs aligned with implementation: SKILL.md documents the grounded Gate B loop and Gate A voting rules as implemented; cross-harness overlays marked as manual/roadmap; re-mined dogfood artifacts (`SKILLS_MINED.md` + JSON sidecar) replace the stale 2026-06-08 report.

### Added (carried from the 1.9.0-era polish pass, previously listed as Unreleased)
- `CONTRIBUTING.md`, `SECURITY.md` (with accurate symlink and exit-code scope), `.github/workflows/test.yml` (CI test matrix on Node 20 + 22), GitHub issue and PR templates.
- `CHANGELOG.md` documenting all prior releases.
- `package.json`: `keywords`, `bugs`, `homepage` fields for npm discoverability.
- `skill-mining/SKILL.md`: version synced to 1.8.0.

### Fixed
- `survey.js`: non-git directory walks now use `lstat` and skip symlinks, preventing path traversal outside the target root.
- `validate.js`: ecosystem search failure and Gate B empty-result failures now exit with code 3 (operational error) instead of 1 (argument error), matching the documented exit-code contract.
- `README.md`: validate exit-code table corrected (exit 3 for operational errors, not 1; exit 1 reserved for argument/config errors); `FIX` verdict description clarified; registry-failure troubleshooting updated to say `DEFER` (not `UNAVAILABLE`).
- `skill-mining/SKILL.md`: exit-code table synced to match README (exit 1 = arg error, exit 3 = operational error).
- `README.md` and `skill-mining/SKILL.md`: exit-code table now covers all four codes including `--prompt-only` intermediate pauses.
- Removed `mine.md` (internal LLM build-spec) from the repository root.
- `.gitignore`: added patterns for test run artifacts (`test-*.SKILL.md`) and internal LLM prompts (`.claude/mine-spec.md`).

### Changed
- Minimum Node.js version raised to 20 (Node 18 reached EOL April 2025). Updated `package.json` `engines`, `CONTRIBUTING.md`, and CI matrices.

## [1.8.0] — 2026-06-22

### Added
- `validate` subcommand: vet a single `SKILL.md` through Dedupe + Gate B without running a full repo survey. Supports `--json`, `--prompt-only`, `--registry`, `--also-local`, `--install`, `--refine`, `--force`, `--offline`, `--quiet`.
- 24-hour result cache for `validate` runs; `--force` bypasses it.
- `--refine` flag: propose Gate B edits as a diff, prompting before writing (headless: emit diff + exit 2).
- Skeptic-first prompting: adversarial gates now default verdict to REUSE/REJECT, requiring the build case to survive an attack.
- Schema-valid verdict JSON output (`--json`) with `schemaVersion`, `dedup`, `gateB`, `scoring`, `verdict`, `exitCode`, and `complete` fields.
- ADLC provenance passthrough: stubs carrying `provenance.clusterSize` / `provenance.evidence[]` have scoring axes derived from provenance instead of re-scored from scratch.

### Fixed
- `validate` mode no longer runs Survey/Score/Author phases — only Dedupe + Gate B as documented.
- Gate B red-team reviewer is given the real directory shape and scripts as ground truth for fact-checking paths/commands.

## [1.7.0] — 2026-06-18

### Added
- Model-tier routing: `--model-strong` for judgment-heavy phases (Detect, Gates, Author, Compose) and `--model-fast` for mechanical phases (Score, Dedupe decision, manifest). Defaults to `claude-sonnet-4-6` / `claude-haiku-4-5`.
- `--gate-model` flag: point the adversarial gates at a separate model/family for cross-model independence.
- Real survey implementation: Phase 1 now performs genuine file-tree mapping, `git log` churn analysis, and pain-marker detection rather than stub output.
- Full adversarial Gate A and Gate B implemented with independent fresh-context reviewers prompted to refute.
- Evidence verification step (Phase 2b): deterministic path-existence check on every LLM-cited file before scoring.

### Fixed
- Gate B SKILL.md frontmatter repaired.
- `release` skill hidden from public registry (intended for internal use only).

## [1.6.1] — 2026-06-15

### Fixed
- README: updated default provider note and local CLI fallback documentation to reflect Anthropic-first ordering.

## [1.6.0] — 2026-06-14

### Added
- `codex exec` fallback for local Codex CLI agent (`--provider codex`).
- Anthropic as default provider; `claude -p` argument-passing support for the local Claude CLI fallback.

## [1.5.0] — 2026-06-13

### Fixed
- CI/CD: npm publish workflow now correctly triggers on `v*` tag pushes.

## [1.4.0] — 2026-06-13

### Fixed
- npm package configuration corrected (missing entry-point mapping).

### Docs
- README updated with local CLI execution option (`node bin/cli.js`).
- Mining report refreshed.

## [1.3.0] — 2026-06-13

### Added
- Core skill mining phases: Survey, Detect, Score, Dedupe, Author, Compose, Verify & Report.
- Fingerprinting module for skill directory content hashing (enables `--agents-only` integrity checks).
- `SKILLS_MINED.json` machine-readable sidecar written alongside `SKILLS_MINED.md`.
- Mined skill definitions from this repo itself (ecosystem-skill-deduplication, gate-b-red-team-verification, release).
- `npx skill-mining mine` zero-install entry point via npm publish workflow.
- Team manifest: agent roster with handoff order wired into the report.
- Portable agent definitions following the cross-harness `SKILL.md` format.
- Anti-sprawl hardening: reuse search fail-closed policy.

[1.8.0]: https://github.com/voodootikigod/skill-mining/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/voodootikigod/skill-mining/compare/v1.6.1...v1.7.0
[1.6.1]: https://github.com/voodootikigod/skill-mining/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/voodootikigod/skill-mining/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/voodootikigod/skill-mining/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/voodootikigod/skill-mining/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/voodootikigod/skill-mining/releases/tag/v1.3.0
