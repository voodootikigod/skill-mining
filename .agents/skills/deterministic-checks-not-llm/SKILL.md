---
name: deterministic-checks-not-llm
description: >-
  Use when adding any verification, gate routing, artifact linting, evidence
  checking, or report rendering to the skill-mining pipeline — e.g. "verify the
  cited paths exist", "route this candidate to the risk gate", "render the
  SKILLS_MINED.md table", "add a new check on authored artifacts". The invariant:
  anything checkable without a model MUST be checked without a model (Set
  lookups, word-anchored regexes, sha256 manifests), it must fail closed, and
  its findings are handed to LLM reviewers as confirmed defects they may not
  overrule. Extends jpcaparas/skills@heuristic-to-deterministic with this repo's
  enforcement layer.
license: MIT
user-invocable: true
metadata:
  version: 1.0.0
  source: mined from skill-mining
  evidence: >-
    src/evidence.js (verifyCandidateEvidence Set lookup), src/grounding.js +
    test/grounding.test.js (path/npm-script grounding vs survey),
    src/fingerprint.js + test/fingerprint.test.js (sha256 directory manifest),
    src/lint.js (deterministic artifact lint), src/gates.js (RISK_RE keyword
    routing), src/report.js (deterministic report rendering)
---

# Deterministic Checks, Not LLM

In this repo (the `skill-mining` mining pipeline), every verification that *can*
be computed from data *is* computed from data — the model is only used where
judgment is genuinely required (detection, scoring, authoring, adversarial
gates). This invariant exists because model-based checks silently fail open:
model-rendered tables drop rows, model "verification" of file paths hallucinates
existence, and keyword judgment drifts run-to-run. The enforcement layer lives
in `src/evidence.js`, `src/grounding.js`, `src/fingerprint.js`, `src/lint.js`,
`src/gates.js`, and `src/report.js`. Any new check you add must follow the same
contract: deterministic, fail-closed, and upstream of (never overrulable by) the
LLM gates.

## When to use

- Adding or modifying any check on candidates, authored artifacts, or agents
  (evidence verification, grounding, lint, fingerprints).
- Adding routing logic that decides which gate/model a candidate goes to (e.g.
  extending `RISK_RE` in `src/gates.js`).
- Rendering or extending any part of `SKILLS_MINED.md` / `SKILLS_MINED.json` in
  `src/report.js`.
- Reviewing a diff that pipes structured run data through an LLM call — that is
  the anti-pattern this skill exists to reject.
- Tempted to "just ask the model" whether a path exists, a script is real, or a
  table is complete.

## The procedure

1. **Classify the check.** Before writing anything, ask: can this be decided
   from the survey, the filesystem, or the run's structured data? If yes, it is
   a deterministic check and must NOT go through `src/llm.js` (`llmCall` /
   `llmCallJson`). Only genuine judgment (is this pattern valuable? is this
   prose accurate?) goes to a model.
2. **Verify facts by lookup, not by prompt.** Follow
   `verifyCandidateEvidence` in `src/evidence.js`: cited evidence paths are
   checked with a `Set` membership test over `survey.allPaths`. If you need to
   check that an authored artifact's paths or `npm run` scripts are real, extend
   `src/grounding.js` (`groundSkillArtifact`), which grounds artifact content
   against the same survey — never re-derive facts with an LLM call.
3. **Route with word-anchored regexes, not model judgment.** Gate routing in
   `src/gates.js` uses `RISK_RE`, a word-boundary-anchored keyword regex —
   deliberately so substrings don't false-positive (e.g. "author" must not match
   a risk keyword like "auth", "tokenizer" must not match "token"). If you add
   risk keywords, keep the `\b` anchoring and add a test proving the benign
   near-miss words still pass. There is no LLM in the routing.
4. **Make it fail closed.** A check that cannot run (missing survey data,
   unreadable file, failed registry search) must report failure/unknown, not
   pass. The model for this is `src/dedupe.js`: a failed `npx skills` search is
   recorded as `reuse-unchecked` rather than laundered into "nothing exists, so
   BUILD." Never write `catch (e) { return { ok: true } }`.
5. **Hand findings downstream as confirmed defects.** When a deterministic
   check fails, its findings are passed into the Gate A/B prompts as
   *confirmed defects the reviewer may not overrule*. Wire new checks the same
   way in `bin/cli.js` — deterministic result first, then into the gate context.
   The LLM gate may add findings; it may never dismiss deterministic ones.
6. **Render reports from structured data.** `src/report.js` renders
   `SKILLS_MINED.md` (ledger, fingerprint manifest, team manifest table) with
   zero model calls — the model returns structured data (e.g.
   `{ loop, personas }` with handoff targets validated against surviving
   agents), and the renderer emits markdown deterministically. Any new report
   section follows this split: model produces validated JSON, code produces
   markdown. Never ask a model to emit a markdown table of run results.
7. **Fingerprint outputs, don't trust them.** Whole-directory integrity uses
   the sha256 manifest in `src/fingerprint.js` (`verifySkillFingerprint`).
   If you add a new artifact type, include it in the fingerprint manifest so
   tampering/drift is detectable without a model.
8. **Test the check deterministically too.** Every module above has a
   `node --test` suite: `test/evidence.test.js`, `test/grounding.test.js`,
   `test/fingerprint.test.js`, `test/lint.test.js`, `test/gates.test.js`,
   `test/report.test.js`. A new check ships with tests covering the fail-closed
   branch (input missing → check reports failure, not success).

## Conventions / rules

- **No LLM in the routing.** Gate selection, escalation, and pass/fail
  aggregation are pure functions of structured data. `RISK_RE` stays
  word-anchored; add a regression test for every keyword you add.
- **Deterministic findings are non-overrulable.** LLM gate prompts receive them
  as confirmed defects. Do not add prompt language inviting the model to
  re-adjudicate them.
- **Fail closed, and say so.** "Couldn't check" is a distinct recorded state
  (e.g. `reuse-unchecked`), never a silent pass. Bounds and caps are surfaced
  in the report (see `SURVEY_CAPS` in `bin/cli.js`) so a bounded pass never
  reads as exhaustive.
- **Model output is data, not prose-to-trust.** When a model must participate,
  it returns JSON that code validates (see handoff-target validation in the
  team manifest) — the deterministic layer owns everything after that.
- **One source of truth.** Checks compare against the survey
  (`survey.allPaths`, scripts from `package.json`) — never against a second,
  model-remembered copy of the facts.

## Verification

Run the deterministic-layer test suites from the repo root:

```bash
node --test test/evidence.test.js test/grounding.test.js test/fingerprint.test.js test/lint.test.js test/gates.test.js test/report.test.js
```

All tests must pass. Then confirm the invariant holds for your change:

- `grep -n "llmCall" src/evidence.js src/grounding.js src/fingerprint.js src/lint.js src/report.js` returns **no matches** — the deterministic modules import nothing from `src/llm.js`.
- `grep -n "RISK_RE" src/gates.js` shows the word-anchored regex, and `node --test test/gates.test.js` includes a passing case proving benign near-miss words (e.g. "author", "tokenizer") do not trigger escalation.
- If you added a check: force its failure branch (cite a nonexistent path, remove a survey field) and confirm the run **fails or records the unchecked state** — it must not pass silently.
- `npm test` (full `node --test` suite) passes with exit code 0.