# Build prompt — `skill-mining` enhancements for gated single-artifact validation

You are implementing a set of enhancements to **skill-mining**
(`github.com/voodootikigod/skill-mining`, installed via `npx skills add
voodootikigod/skill-mining`). This document is the complete spec. Read it fully,
then verify every claim about *current* behavior against the actual repo before
changing anything — where this prompt and the code disagree, the code is ground
truth and you must flag the discrepancy rather than silently following the prompt.

---

## 1. Why these changes exist

skill-mining today is a **repo-wide capability miner**: an agentic skill that runs a
seven-phase pipeline — Survey → Detect → Score (five-axis) → Dedupe → Author →
Compose → Verify (Gate A decision-challenge, Gate B artifact red-team,
fresh-context validation) — and emits a small portfolio of `SKILL.md` files plus a
`SKILLS_MINED.md` report. It is invoked conversationally ("mine this repo for
skills"). It is **not** a deterministic CLI gate: no machine-readable verdict, no
exit-code contract, no scoped/partial-run mode.

A new consumer needs it: the **ADLC P7 "distill" phase**. ADLC's `lesson-foundry`
tool mines recurring review findings and scaffolds a single `SKILL.md` *stub*. Per
ADLC doctrine ("lesson-foundry emits SKILL.md stubs; skill-mining manages the full
skill registry"), that stub should then be **validated and registered by
skill-mining** before it is merged — specifically deduped against the ecosystem and
run through Gate B so a default-worded, duplicate, or cold-unusable skill never
lands.

Driving that handoff with the current tool means coaxing the whole repo-wide
pipeline into vetting one already-authored file with a prompt constraint
("validate this file, do not mine the rest of the repo"). That is fragile and
unauditable. These enhancements make single-artifact validation a **first-class,
deterministic, scoped operation** while leaving the existing repo-wide mining flow
untouched.

### The calling context (for reference)

- `lesson-foundry --write --out-dir .adlc/lessons` emits a **flat** file at
  `.adlc/lessons/<name>.SKILL.md` (not a `<name>/SKILL.md` directory). It carries
  provenance: the finding-cluster size and verbatim evidence quotes that justified
  the skill.
- `.adlc/lessons/` is a **staging area** — it is not on any harness's
  skill-discovery path. A skill is only "live" once installed into a discoverable
  skills directory.
- The sibling `@adlc/*` gates establish the conventions to match: exit `0` = pass,
  `1` = operational error, `2` = gate fails; `--json` for machine-readable output;
  `--prompt-only` for keyless LLM steps (the model answers the printed prompt and
  the result is applied — no API key required).

---

## 2. Design principles (non-negotiable)

1. **Additive, not destructive.** The existing repo-wide "mine this repo for
   skills" flow must keep working byte-for-byte. New behavior lives behind new
   subcommands/flags; default invocation is unchanged.
2. **Cross-harness.** skill-mining ships through the `npx skills` ecosystem and must
   run under Claude Code, Codex, Cursor, etc. Do not hardcode one harness's skill
   path or invocation. Where a path must be resolved, resolve it from the active
   harness/skills-CLI, not a literal.
3. **Gate DNA.** New machine-callable surfaces follow the `@adlc/*` contract: small,
   `npx`-runnable, zero-or-minimal dependency, deterministic exit codes, `--json`,
   `--prompt-only` for any LLM step. A gate must **fail closed** — if it cannot
   verify, it exits non-zero (never "pass by default").
4. **Honesty over guessing.** Never assert a skill is installed/discoverable from a
   command's success alone; confirm by outcome (the harness can resolve the skill).
   Never fabricate a dedup/Gate result — if a sub-step could not run, the verdict
   says so and the gate fails closed.
5. **No silent writes.** Validation reads; it does not install or mutate the repo
   unless an explicit `--install`/`--write` flag is passed and (in interactive use)
   approved.

---

## 3. Enhancements

Build in the order below. E1–E3 are the headline (they unblock the distill
handoff); E4–E8 are supporting polish.

### E1 — Scoped single-artifact validation mode `(headline)`

**Problem.** Validating one stub today runs the full seven-phase repo survey.

**Deliver.** A scoped entry point that runs **only** Dedupe + Gate B (+ optional
fresh-context validation) against one supplied `SKILL.md`, skipping
Survey/Detect/Score/Author/Compose.

**Interface (agentic + CLI parity):**

```
# CLI / gate form
npx skill-mining validate <path-to-SKILL.md> [--json] [--prompt-only] \
    [--registry skills.sh] [--also-local <dir>...] [--install] [--quiet]

# Conversational form (the skill recognizes a scoped request)
"Validate the skill at <path>: dedup + Gate B only, do not mine the repo."
```

**Behavior:**
- Resolve and parse the target `SKILL.md` (accept a flat `<name>.SKILL.md` file or a
  `<name>/SKILL.md` directory — see E4). Fail closed (exit 2) on missing/unparseable
  frontmatter (`name`, `description` required).
- Run **Dedupe** (E6 governs sources) → one of `REUSE | EXTEND | BUILD | REJECT`.
- Run **Gate B** (artifact red-team): a fresh-context agent receives **only** the
  `SKILL.md` text and attempts a real task drawn from the repo → `SHIP | FIX |
  REJECT`, with the evidence/transcript captured.
- Do **not** Survey/Score/Author. Do not touch other files.
- Emit a verdict (see §4 schema). Exit `0` only when dedup ∈ {EXTEND, BUILD} **and**
  Gate B = SHIP; otherwise exit `2`. Operational failure (could not run a sub-step)
  → exit `1`, verdict marked `incomplete`, fail closed.

**Acceptance criteria:**
- [ ] Running `validate` on a known-good repo-specific stub returns SHIP, exit 0,
      and touches no file other than (optionally) the install target.
- [ ] Running it on a stub that duplicates an installed/registry skill returns REUSE
      and exit 2, naming the colliding skill.
- [ ] Running it on a generic/prose-only stub returns Gate B = REJECT and exit 2.
- [ ] A full repo-wide "mine this repo" run is byte-for-byte unchanged.
- [ ] No Survey/Score work is performed (assert via run log / timing / no
      `SKILLS_MINED.md` portfolio churn).

### E2 — Deterministic gate surface (exit codes + verdict JSON)

**Problem.** skill-mining is agentic-only; it cannot sit in a gated pipeline or CI.

**Deliver.** Every machine-callable mode (starting with `validate`) returns a stable
verdict JSON (§4) on `--json` and obeys the exit-code contract (`0` pass, `1`
operational error, `2` gate fail). Provide `--prompt-only` for the LLM-backed
sub-steps (dedup reasoning, Gate B) so the operation is keyless: print the exact
prompt, let the calling model answer, apply the result.

**Acceptance criteria:**
- [ ] `npx skill-mining validate <path> --json` prints schema-valid JSON to stdout
      and nothing else (logs go to stderr).
- [ ] Exit code matches the verdict deterministically across repeated runs on the
      same input.
- [ ] `--prompt-only` performs no network/model call and prints a non-empty,
      answerable prompt; the documented re-entry applies the answer.
- [ ] Fail-closed proven: simulate a dedup/Gate-B sub-step failure → exit 1, verdict
      `incomplete`, never exit 0.

### E3 — Pre-authored stub as input (skip Author)

**Problem.** skill-mining authors skills *from* a survey; the distill case supplies
an already-authored stub to *vet*, not generate.

**Deliver.** `validate` (E1) accepts the stub as the unit of work and never
regenerates/overwrites its body. An optional `--refine` flag may *propose* edits
(printed as a diff under `--prompt-only`, applied only with explicit approval), but
the default is read-only validation.

**Acceptance criteria:**
- [ ] The input `SKILL.md` body is unchanged after a default `validate` run.
- [ ] `--refine` produces a proposed diff but does not write without approval.

### E4 — lesson-foundry artifact adapter

**Problem.** lesson-foundry emits a flat `.adlc/lessons/<name>.SKILL.md`; the skills
CLI/registry expects a skill **directory** (`<name>/SKILL.md`). Today a human must
hand-move the file.

**Deliver.** `validate`/install logic recognizes the flat ADLC staging convention
and normalizes it internally (flat `<name>.SKILL.md` ⇄ `<name>/SKILL.md`) without
the human moving files. On `--install` for a SHIP verdict, place it into the
discoverable location resolved from the active harness/skills-CLI (do not hardcode
the path), and leave the staging copy alone (caller decides whether to remove it).

**Acceptance criteria:**
- [ ] A flat `<name>.SKILL.md` is accepted directly as input.
- [ ] `--install` on a SHIP verdict yields a skill the active harness can discover
      (verified by outcome, not by command success).
- [ ] No path literal for a specific harness appears in the implementation.

### E5 — Provenance-aware scoring

**Problem.** lesson-foundry stubs already encode the frequency/leverage evidence
(finding-cluster count, evidence quotes); skill-mining re-derives signal from git
churn, ignoring it.

**Deliver.** When the stub carries ADLC provenance (frontmatter or a companion
metadata block — define the field, e.g. `provenance: { clusterSize, evidence[] }`),
feed it into the five-axis rubric (frequency, leverage, verifiability) instead of
re-deriving. Absent provenance, fall back to current behavior.

**Acceptance criteria:**
- [ ] A stub with `clusterSize: N` is scored using N as the frequency signal
      (assert in the verdict's scoring rationale).
- [ ] A stub with no provenance scores exactly as today.

### E6 — Dedup against local ADLC skills, not just the public registry

**Problem.** Dedupe checks installed skills + `skills.sh`. It misses prior ADLC
lessons, so distill can re-mint a near-duplicate of an earlier lesson.

**Deliver.** `--also-local <dir>...` (default includes the repo's `.adlc/lessons/`
and any installed ADLC skills) adds those as dedup sources alongside the registry.

**Acceptance criteria:**
- [ ] A stub matching an existing `.adlc/lessons/` entry returns REUSE/EXTEND,
      naming the local match.

### E7 — Headless / advisory mode

**Problem.** As an interactive skill, it assumes a live agent + ability to install.
A scheduled, unattended `/adlc-distill` must run advisory-only.

**Deliver.** `--report-only` (or honor a `CI`/headless signal): run dedup + Gate B,
emit the verdict, **write/install nothing**, never prompt interactively. Mirrors the
advisory posture of the rest of distill.

**Acceptance criteria:**
- [ ] `--report-only` produces a full verdict and zero filesystem mutations.
- [ ] No interactive prompt is emitted in this mode.

### E8 — Idempotent re-validation

**Problem.** Re-running on an unchanged stub re-does dedup + Gate B from scratch.

**Deliver.** Extend the `SKILLS_MINED.md` (or a sidecar ledger) memory so a stub
whose content hash + dedup sources are unchanged returns the cached verdict as a
fast no-op, with a flag (`--force`) to bypass the cache.

**Acceptance criteria:**
- [ ] Second `validate` of an unchanged stub is a fast no-op returning the prior
      verdict; `--force` re-runs.
- [ ] Any change to the stub content or dedup sources invalidates the cache.

---

## 4. Verdict JSON schema (E2)

```json
{
  "schemaVersion": "1",
  "target": "string (path to the validated SKILL.md)",
  "skillName": "string (from frontmatter)",
  "dedup": {
    "decision": "REUSE | EXTEND | BUILD | REJECT",
    "match": "string|null (colliding skill id, if any)",
    "sources": ["installed", "skills.sh", ".adlc/lessons", "..."],
    "rationale": "string"
  },
  "gateB": {
    "verdict": "SHIP | FIX | REJECT",
    "task": "string (the real task the fresh agent attempted)",
    "evidence": "string (what proved/failed it)",
    "missing": ["string (specific commands/paths/invariants absent, if FIX/REJECT)"]
  },
  "scoring": {
    "frequency": 0, "leverage": 0, "bespokeness": 0,
    "stability": 0, "verifiability": 0,
    "provenanceUsed": true,
    "rationale": "string"
  },
  "verdict": "SHIP | FIX | REJECT | REUSE | INCOMPLETE",
  "exitCode": 0,
  "complete": true,
  "notes": "string"
}
```

- `verdict` is the single rolled-up decision; `exitCode` mirrors it deterministically
  (`SHIP` → 0; `FIX`/`REJECT`/`REUSE` → 2; `INCOMPLETE` → 1).
- `complete: false` ⇒ a sub-step could not run ⇒ fail closed (exit 1).

---

## 5. Resulting CLI surface (summary)

| Command | Purpose | Exit contract |
| --- | --- | --- |
| `npx skill-mining` (or "mine this repo for skills") | Existing repo-wide mine | unchanged |
| `npx skill-mining validate <SKILL.md>` | Scoped dedup + Gate B on one stub | 0 SHIP / 2 fail / 1 incomplete |
| `… --json` | Machine-readable verdict (§4) | as above |
| `… --prompt-only` | Keyless: print prompts for the model to answer | n/a |
| `… --install` | On SHIP, place into the discoverable location (E4) | as above |
| `… --report-only` | Advisory; no writes (E7) | as above |
| `… --also-local <dir>` | Extra dedup sources (E6) | as above |
| `… --refine` | Propose body edits as a diff (E3) | as above |
| `… --force` | Bypass the re-validation cache (E8) | as above |

---

## 6. Backward compatibility

- The default conversational invocation and the seven-phase pipeline are unchanged.
- All new behavior is opt-in via the `validate` subcommand and flags.
- `SKILLS_MINED.md` format is extended additively (new fields/sidecar), not broken.

---

## 7. Test plan

- **Unit:** frontmatter parse/fail-closed; flat⇄dir normalization (E4); exit-code
  mapping (E2); cache hit/invalidation (E8); provenance scoring vs fallback (E5).
- **Integration:** `validate` on (a) good repo-specific stub → SHIP/0; (b) registry
  duplicate → REUSE/2; (c) generic prose stub → REJECT/2; (d) simulated sub-step
  failure → INCOMPLETE/1. Assert no Survey/Score side effects.
- **Cross-harness:** `--install` yields an outcome-discoverable skill under at least
  two harnesses (or a documented adapter seam if only one is available in CI).
- **Regression:** a full repo-wide mine run is identical pre/post change.
- **Keyless:** `--prompt-only` makes no model/network call and round-trips an applied
  answer.
- Every LLM-backed gate (`@adlc/*` DNA) must be runnable in CI via deterministic exit
  codes.

---

## 8. Build order

1. **E1 + E2 + E3** — scoped `validate` with deterministic JSON/exit codes that
   ingests a pre-authored stub. This alone unblocks the ADLC distill handoff.
2. **E4** — lesson-foundry flat-file adapter + outcome-verified install.
3. **E5, E6** — provenance scoring and local dedup sources.
4. **E7, E8** — headless/advisory mode and re-validation cache.

Ship each as an independently useful increment, mirroring the toolkit's
"every tool is one gate" philosophy. After each increment, run an adversarial review
(`npx adversarial-review`, a model different from the builder) and resolve material
findings before moving on.

---

## 9. Out of scope

- Replacing or restructuring the existing repo-wide mining pipeline.
- Authoring/generating skill bodies from scratch in the `validate` path (that is the
  existing Author phase; `validate` only vets, and `--refine` only proposes).
- Hardcoding any single harness's skill-discovery path.
- Changing `lesson-foundry` or the `/adlc-distill` command (separate repos; this
  spec only consumes their existing output contract).
