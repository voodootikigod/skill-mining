---
name: ecosystem-skill-deduplication
description: >-
  Use when performing anti-sprawl checks against the community registry using
  npx skills find to check if a candidate skill can be reused or extended before
  building a duplicate.
license: MIT
user-invocable: true
metadata:
  version: 1.0.0
  source: mined from skill-mining
  evidence: src/dedupe.js lines 4-44, skill-mining/SKILL.md lines 209-253
---

# Ecosystem Skill Deduplication

This skill defines the process for performing anti-sprawl checks against the community skill registry to verify whether a candidate skill can be reused, extended, or needs to be built from scratch. It protects the codebase from duplicate implementations ("skill sprawl") by enforcing a strict fail-closed network policy during registry searches.

## When to use

- When running the deduplication phase (Phase 4) of the skill mining loop to verify candidate skills against the community registry.
- When determining whether a new candidate skill should be classified as `REUSE`, `EXTEND`, `BUILD`, or `REJECT`.
- When diagnosing fail-closed errors during registry search operations (e.g., due to network timeouts or registry outages).
- When validating previously generated skills in partial modes (like `--agents-only` or `--report-only`) to ensure their reuse-check status is valid.

## The procedure

1. Run the deduplication checks programmatically during a full mining pass by running the CLI from the repository root:
   ```bash
   node bin/cli.js
   ```
   *Note: This default invocation requires an active network connection to query the registry.*

2. To manually verify the ecosystem registry for a candidate skill, invoke the community search CLI directly:
   ```bash
   npx -y skills find "<candidate-skill-name>"
   ```
   If the companion skill `find-skills` is installed, use it instead for enhanced context and leaderboard checks.

3. Classify the candidate skill based on search results:
   - **REUSE**: If a community package matches the candidate, record the package (e.g., `user/repo@version`) as the source in the final decision metadata.
   - **EXTEND**: If a community package matches the foundation but requires repository-specific customization, classify as `EXTEND` and keep the package source.
   - **BUILD**: If no suitable packages are found and the skill represents genuinely unique tribal knowledge, proceed with `BUILD` using `this repo` as the source.
   - **REJECT**: If the candidate is determined to have low leverage or utility, assign `REJECT`.

4. Understand local offline handling and the lack of a local cache:
   - The CLI does not maintain a local registry database or cache file.
   - When running in offline mode (`--offline`), registry queries are bypassed or allowed to fail.
   - Without a local database/cache, any candidate skill search is automatically resolved with an empty registry result and marked as `SEARCH UNAVAILABLE - RUNNING IN OFFLINE MODE`.
   - This causes the LLM decision to default to a local `BUILD` (marked as `reuse-unchecked`) or retain a proposed `REUSE`/`EXTEND` classification without validation. Duplicate ecosystem skills cannot be filtered out locally against the community registry in offline mode.

5. Handle offline mode or search timeouts:
   - If the search fails or times out, the CLI throws a `FAIL CLOSED` error to prevent accidental duplicate builds.
   - If you must run without network connectivity, explicitly pass the `--offline` flag to enable graceful degradation:
     ```bash
     node bin/cli.js --offline
     ```
   - In offline mode, the search results are marked as `SEARCH UNAVAILABLE - RUNNING IN OFFLINE MODE`, and any built skills will carry the `reuse-unchecked (offline @ <timestamp>)` status.

6. Reconcile offline-generated skills:
   - When running the CLI subsequently in online mode (or running partial commands like `node bin/cli.js --agents-only`), any skill marked as `reuse-unchecked` will trigger a validation failure.
   - Re-run the full mining pass in online mode to verify all `reuse-unchecked` skills against the registry, or bypass the check again using the `--offline` flag.

## Conventions / rules

- **Anti-Sprawl Guarantee (Fail-Closed)**: Never assume a failed registry search indicates that a skill does not exist. A failed search must fail closed (stop execution or require the `--offline` override).
- **No Wildcard Reuse**: If a skill decision is `REUSE`, the source must point to a pinned package and version (e.g., `user/repo@version`), never generic tags or `"this repo"`.
- **Security Check Priority**: Before assigning `REUSE` or `EXTEND`, verify the security audit signal of the package from the registry output. Do not reuse packages with active security alerts.
- **Offline Override Tracking**: Every skill built or extended during an offline run must be explicitly stamped in `reuseCheckStatus` with `reuse-unchecked` and the ISO timestamp of the run.

## Verification

1. To verify the fail-closed behavior, simulate network failure or registry blockage. A concrete method is to route traffic through a non-existent local proxy by setting dummy proxy environment variables:
   ```bash
   HTTP_PROXY=http://127.0.0.1:9999 HTTPS_PROXY=http://127.0.0.1:9999 node bin/cli.js
   ```
   Ensure it fails with a message mentioning `FAIL CLOSED` and directing to use the `--offline` flag.

2. Verify that running with the offline flag logs the expected warning and bypasses the failure:
   ```bash
   node bin/cli.js --offline
   ```
   Ensure the output logs print:
   `Offline Mode: Allowed local build of`

3. Confirm that no external requests are initiated (or that external failures are successfully bypassed) when the `--offline` flag is active:
   - Run the command with the dummy proxy active:
     ```bash
     HTTP_PROXY=http://127.0.0.1:9999 HTTPS_PROXY=http://127.0.0.1:9999 node bin/cli.js --offline
     ```
   - Verify that it succeeds without throwing a `FAIL CLOSED` error and logs:
     `Search failed/offline. Offline mode enabled, so proceeding.`

4. Inspect the generated `SKILLS_MINED.md` report in the target directory (e.g., repository root). Verify that:
   - Every `BUILT` or `EXTEND` skill lists its `reuseCheckStatus` as either `reuse-checked: <name> via npx skills find @ <timestamp>` (if run online) or `reuse-unchecked (offline @ <timestamp>)` (if run offline).
   - Every `REUSED` skill has a source pointing to a valid package name with a pinned version (e.g. `user/repo@version`).

5. Run partial mode verification to ensure validation checks pass:
   ```bash
   node bin/cli.js --report-only
   ```
   Ensure it exits with `0` and logs `All existing skills verified successfully`.