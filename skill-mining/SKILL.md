---
name: skill-mining
description: >-
  Use when you want to extract reusable agent skills and agent definitions from
  an existing codebase — "mine this repo for skills", "what skills should we
  build from this project", "turn our patterns into skills", standardizing team
  practices, onboarding agents to a project, or building a skill/agent
  portfolio. Reviews a codebase, scores candidate skills by leverage, dedupes
  against the existing ecosystem (reuse vs build), authors SKILL.md files, and
  composes agent definitions that orchestrate them into an implementation team.
license: MIT
user-invocable: true
argument-hint: "[path-or-scope] [--no-agents] [--no-team] [--agents-only | --report-only]"
metadata:
  version: 1.0.0
  author: Chris Williams (@voodootikigod)
  homepage: https://skills.sh
---

# Skill Mining

**Skill mining** is the practice of pointing an agent at a codebase and asking
it: *what reusable skills and agents are latent in here that would make every
future change faster, more accurate, and easier to maintain?* You then extract
those skills as durable artifacts (`SKILL.md` files and agent definitions) that
ship with the repo and get sharper every time they're used.

A codebase is not just product code. It is also a record of how a team builds:
the build and test invocations everyone re-derives, the domain rules encoded in
scattered validators, the architectural conventions enforced only by code
review, the deploy dance nobody wrote down. Each of those is a *skill waiting to
be mined* — institutional knowledge currently re-discovered on every task. Skill
mining surfaces that knowledge, scores it, and turns the highest-leverage pieces
into capabilities your agents load on demand.

This skill is the repo-level loop. The same loop run continuously across a whole
organization's AI traffic — instead of one repository — becomes portfolio
curation: the operating model that makes agentic adoption affordable and
governable at enterprise scale.

## When to use this skill

- "Mine this repo / project / package for skills."
- "What skills and agents should we build to speed up work on this codebase?"
- Standardizing a team's practices so agents stop re-deriving them.
- Onboarding agents to an unfamiliar or sprawling codebase.
- Building or refreshing a skill + agent portfolio for a project.
- After a big refactor or new subsystem lands — mine the new conventions.

## What you produce (output contract)

By the end of a run you deliver, written to the repo:

1. **Mined skills** — one `SKILL.md` per kept candidate, in the harness skills
   directory (`.agents/skills/<name>/` for cross-harness; see
   `references/cross-harness.md`).
2. **Mined agents** — one agent definition per role that composes the skills
   (`references/templates/agent-template.md`).
2a. **A team manifest** (default on) — inside the report: the agent roster, the
   skills each loads, and the handoff order so the personas operate *as a team*,
   not a bag of agents.
3. **A mining report** — `SKILLS_MINED.md` at the repo root: every candidate,
   its score, the reuse-vs-build decision, and why
   (`references/templates/report-template.md`).

## Options

All optional. Sensible defaults mean a bare "mine this repo for skills" produces
the full output (skills + agents + team). Flags only *remove* work.

| Flag | Default behavior | Effect when set |
|---|---|---|
| *(none)* | Mine skills **and** agents, composed **as a team**. | — |
| `--no-agents` | Agents are built. | Skip Phase 6 entirely. Skills + report only. (Alias: `--skills-only`.) |
| `--no-team` | Personas are wired into a team (handoffs + manifest). | Build the agent personas, but as standalone roles — no team-composition step, no team manifest. |
| `--agents-only` | — | Assume skills already mined; (re)compose agents + team from the existing skills. |
| `--report-only` | — | Re-emit `SKILLS_MINED.md` from prior results; author nothing. |

Precedence: `--no-agents` implies `--no-team` (no agents ⇒ no team). If the user
didn't pass a flag, default to the fullest output — agents and team included.

**Partial modes read prior state; fail closed if it's missing.** `--agents-only`
and `--report-only` do not re-mine — they depend on artifacts a previous full run
left behind. Their single source of truth is **`SKILLS_MINED.md`** plus the
installed skill directories it references.

- `--agents-only` requires `SKILLS_MINED.md` with each skill's **path** and
  **content fingerprint** (see the report's identity table). The fingerprint
  covers the **whole skill directory** — `SKILL.md` plus every `references/`,
  `scripts/`, and `templates/` file — since supporting files carry loaded
  instructions. The report records a **per-skill file manifest** (sorted
  `path sha256` lines); the fingerprint is the hash of that manifest. Before
  composing, **re-derive each manifest from disk and compare it to the report**,
  failing on any added, removed, or changed file, or an absent manifest.
  Verification policy
  by origin: a **BUILT/EXTENDED** skill must carry matching fingerprint **+ Gate B
  evidence + a `reuse-checked` status**; a **REUSED** community skill must carry a
  matching **pinned source version** (no Gate B — it is community-maintained, not
  authored here). Only wire agents to skills that satisfy their origin's policy.
  **Reject any BUILT/EXTENDED skill still marked `reuse-unchecked`** (built offline)
  unless the user has approved offline mode *for this run* — otherwise the offline
  escape hatch becomes permanent and an un-searched duplicate ships indefinitely.
- `--report-only` requires a prior `SKILLS_MINED.md` (or the structured results
  from a same-session run) to re-emit.

If a required artifact is **absent, fingerprint-mismatched (the skill changed
since it was verified), a BUILT/EXTENDED skill missing Gate B, a BUILT/EXTENDED
skill still `reuse-unchecked` without current offline approval, a REUSED skill
missing its version pin, or internally inconsistent**, STOP and tell the user to
run a full pass — do not reconstruct state from guesses, and never wire an agent
to a skill whose recorded verification no longer matches its current content.

Nothing is silently dropped. Every candidate considered appears in the report,
even the rejected ones — a rejected candidate with a clear reason is a real
output, because it stops the next person re-mining the same dead end.

## The mining loop

Seven phases plus two **adversarial gates**. They mirror a portfolio-curation
loop so the practice scales from one repo to a whole org: **Survey → Detect →
Score → ⟂Challenge → Dedupe → Author → ⟂Red-team → Compose → Verify & Report.**

```
Survey → Detect → Score →[⟂A]→ Dedupe → Author →[⟂B]→ Compose → Verify+Report
 (map)  (cands.)  (rank)  chal-  (reuse   (write    red-   (agents   (prove value,
                          lenge   vs build) SKILL.md) team   use skills) write report)
```

The two `⟂` gates are independent adversarial reviews — the counterweight to the
loop's natural bias toward building clever, bespoke skills. **Gate A** challenges
the build-vs-reuse *decision* (protects accuracy); **Gate B** red-teams the
authored *artifact* (protects meaningfulness). Both must be run by a *separate,
fresh-context* reviewer prompted to refute — a self-review rubber-stamps. A
lightweight completeness critic also runs at Detect. Mechanics, prompts, and
voting rules are in `references/adversarial-review.md`.

Run phases Survey→Score broad and parallel; run Author→Compose surgical and
sequential. If your harness has parallel subagents or a workflow engine (Claude
Workflow, Codex parallel tasks, etc.), fan out the Survey and Detect phases —
one explorer per subsystem — then converge. If it doesn't, iterate sequentially;
the method is identical, only the wall-clock changes.

### Phase 1 — Survey (map the territory)

Build a factual map before judging anything. Gather, don't opine:

- **Shape**: languages, frameworks, package layout, entry points, `package.json`
  / `pyproject` / `go.mod` scripts, CI config, deploy config.
- **Build/test/run reality**: the actual commands that build, test, lint, type-
  check, migrate, and deploy. These are the cheapest, highest-hit-rate skills —
  every agent re-derives them otherwise.
- **Hotspots**: `git log` churn (files changed most often), large files, and
  directories with the densest commit history. High churn = high leverage; a
  skill that speeds up the hottest files pays back fastest.
- **Conventions**: naming, folder organization, error-handling style, data-
  access patterns, test layout — the rules a reviewer would enforce by hand.
- **Pain markers**: `TODO`/`FIXME`/`HACK` clusters, files with the most bug-fix
  commits, recurring revert patterns, flaky-test markers.

Use `references/candidate-taxonomy.md` as the checklist of *where skills hide* so
you sweep every category, not just the obvious code.

### Phase 2 — Detect (surface candidates)

Turn the map into a list of **candidate skills** and **candidate agents**.

A candidate skill is any *recurring, transferable unit of know-how* a competent
agent would otherwise re-derive: a build incantation, a domain rule, an
architectural pattern, a review checklist, a migration recipe, a debugging
playbook for a known failure mode. A candidate agent is a *role* — a job-to-be-
done that orchestrates several skills (implementer, fixer, reviewer, migrator).

For each candidate capture: name, one-line description, the evidence in the repo
(files/lines/commits that prove it recurs), and which type it is. Cast wide
here — pruning happens next.

**Completeness critic.** Before moving on, run one cheap inverse pass: hand the
candidate list and the churn/hotspot map to a fresh reviewer and ask *what high-
leverage recurring knowledge did this sweep miss?* Anything it surfaces re-enters
the list. See `references/adversarial-review.md`.

### Phase 3 — Score (rank by leverage)

Score every candidate so you build the few that matter, not the many that don't.
Use the rubric in `references/scoring-rubric.md`. Five axes, 1–5 each:

| Axis | Question |
|------|----------|
| **Frequency** | How often does this knowledge get re-used or re-derived? |
| **Leverage** | How much time/error does encoding it save per use? |
| **Bespokeness** | How specific is it to *this* codebase vs already in the ecosystem? |
| **Stability** | Will it stay true, or churn out of date in weeks? |
| **Verifiability** | Can an agent check it followed the skill correctly? |

Build the top band, defer the middle, reject the bottom. Record every score in
the report — the scores are the argument for the reuse-vs-build decision.

### Gate A — Challenge the decision (adversarial)

Scores written by the agent that proposed the candidate are self-serving — the
loop wants to build things, so Leverage and Bespokeness drift up. Before any
candidate proceeds, an **independent, fresh-context skeptic** re-examines it with
the burden of proof reversed: default verdict is REUSE or REJECT, and the case
for BUILD has to survive an attack on its recurrence evidence, its bespokeness
("name a public skill that already covers this"), its leverage, and its
stability. Only survivors proceed. Record the revised scores and the strongest
objection in the report. Full prompts and voting rules (single skeptic vs. 3 +
majority/veto for safety-relevant skills) are in
`references/adversarial-review.md`.

### Phase 4 — Dedupe (reuse before you build)

For each surviving candidate, **check the ecosystem before authoring anything.**
The cheapest skill is the one someone already maintains. This step is the whole
defense against **skill sprawl** — never skip it.

**Preflight — secure the search capability (do this once per run).** The reuse
search needs the `skills` CLI; it is zero-install (`npx skills …` fetches it on
demand), so there is nothing to set up. The `find-skills` skill is a recommended
companion that makes the search smarter (leaderboard reasoning, source-trust
checks), but it is **not required** — this skill degrades gracefully without it.

- If `find-skills` is installed → use it to drive the search.
- If not → either bootstrap it (`npx skills find find-skills`, then
  `npx skills add <the result>`) or, equally valid, **proceed directly** with
  `npx skills find <query>`. Do **not** block or fail on a missing `find-skills`.

**Two failures, two policies — don't conflate them:**

| Condition | Policy |
|---|---|
| `find-skills` companion **absent** | Degrade silently to `npx skills find`. Not an error. |
| The **search itself fails** (no network, CLI fetch fails, registry/leaderboard unreachable) | **Fail closed.** A failed search is *not* "no match found." Record the candidate's reuse check as **UNAVAILABLE** in the report and do **not** silently BUILD. Stop and tell the user, or proceed only under an explicit user-approved **offline mode** (which must mark every BUILT skill as "reuse-unchecked" so it's re-checked on the next online pass). |

The anti-sprawl guarantee depends on this: a BUILD is only justified once a
*successful* search found no reusable skill. "I couldn't search" must never be
laundered into "nothing exists, so I'll build it."

Then, for each candidate:

1. Search installed skills and the open registry — via `find-skills` if present,
   otherwise `npx skills find <query>` plus the https://skills.sh leaderboard.
2. Decide and record one of: **REUSE** (install an existing skill — note the
   package), **EXTEND** (existing skill + a thin repo-specific overlay),
   **BUILD** (genuinely bespoke — author it), or **REJECT** (score too low).

High bespokeness + high leverage ⇒ BUILD. Low bespokeness ⇒ REUSE/EXTEND, never
re-implement a battle-tested community skill. This decision *is* the value of
skill mining — most candidates should resolve to reuse.

### Phase 5 — Author (write the skills)

For each BUILD/EXTEND candidate, write a `SKILL.md` using
`references/templates/skill-template.md`. Rules that make a skill good:

- **Trigger-rich description.** The `description` is how the skill gets
  discovered — pack it with the phrases a user would actually say. This is the
  single highest-leverage field; write it last, after you know the body.
- **One job per skill.** If it needs "and" to describe, split it.
- **Progressive disclosure.** Keep `SKILL.md` lean; push long checklists,
  tables, and examples into `references/` files the agent loads on demand.
- **Show the repo's real commands and paths**, not generic advice. A mined skill
  earns its keep by being specific: the actual test command, the actual module
  layout, the actual gotcha.
- **Make it verifiable.** State how an agent confirms it applied the skill
  correctly (a command to run, an output to check).

### Gate B — Red-team the artifact (adversarial)

A skill reads fine to its author because the author fills the gaps from memory. A
cold agent can't. After authoring, hand the `SKILL.md` **and nothing else** — not
the survey, not the proposer's reasoning — to a fresh-context agent and tell it to
complete a real recent task or diff *using only the skill*. It reports every place
the skill was ambiguous, sent it to a wrong path/command, assumed unstated
knowledge, or couldn't be verified. Verdict: SHIP / FIX (with edits) / REJECT.
FIX findings loop back into authoring; a skill only enters the report as
*verified* once it survives Gate B with "I used it and it worked" evidence. This
replaces a weaker self dry-run. See `references/adversarial-review.md`.

### Phase 6 — Compose (mine the agents)

> **Skipped entirely under `--no-agents` / `--skills-only`.** Default is to run it.

Skills are capabilities; agents are *roles that wield them*. Compose agent
definitions (personas) that bind the mined skills into specialists. Typical
roster for a repo:

- **Implementer** — builds features using the architecture + convention skills.
- **Fixer** — diagnoses and repairs using the debugging + test skills.
- **Reviewer** — enforces the convention + security skills as a checklist.
- **Migrator/Operator** — runs the build/deploy/migration skills safely.

Use `references/templates/agent-template.md`. Each agent names the specific
skills it loads, its neutral **capabilities** (read/edit/search/run — *not*
harness tool names), and its operating procedure. Concrete `tools`/`model` fields
are emitted **only** in a target-harness overlay, never in the portable
definition — see `references/cross-harness.md`. The point is specificity: a
generic "reviewer" is weak; a reviewer that loads *this repo's* convention and
security skills reviews like a senior engineer who's worked here
for years.

#### Team composition (default on; skipped under `--no-team`)

Four good specialists are not yet a team. Unless `--no-team` is set, wire them
into a workflow: define **who hands off to whom** and **in what order** for the
common jobs. A typical loop:

```
Implementer ──(diff)──▶ Reviewer ──(findings)──▶ Fixer ──(patch)──▶ Reviewer ✓
                                                       │
                            Migrator/Operator ◀──(schema/deploy change)──┘
```

For each persona record its **triggers** (when it's invoked), its **inputs** and
**outputs** (what it receives and hands off), and its **escalation** (when it
kicks work to another persona or back to a human). Capture this as the **team
manifest** (next phase, in the report) so the roster is runnable, not just a
list. The manifest is the artifact that makes "drive improvements *as a team*"
real instead of aspirational.

### Phase 7 — Verify & Report

A mined skill is a hypothesis until it's proven. Verify:

- **Carry forward Gate B evidence.** Each built skill should already have a
  "used it cold, it worked" result from its red-team. If a skill skipped Gate B,
  it is not verified — send it back.
- **Lint the artifacts**: valid frontmatter, unique names, descriptions that
  actually contain trigger phrases, no dangling reference links.
- Write `SKILLS_MINED.md` from `references/templates/report-template.md`: the
  candidate table with scores and decisions, install instructions, and a short
  "next mining pass" list of deferred candidates.
- **Include the team manifest** (unless `--no-team`/`--no-agents`): the roster,
  each persona's loaded skills, and the handoff order from Phase 6.
- **State what was excluded.** If `--no-agents` or `--no-team` was set, say so in
  the report so a reader knows the agents/team were skipped by choice, not missed.

Then tell the user what to install and how (`npx skills add ...` or copy into
their harness skills dir — see `references/cross-harness.md`).

## Cross-harness portability

Skills authored by this loop follow the open `SKILL.md` format and load in
Claude (Code/Desktop), Codex, Antigravity, Cursor, Zed, and anything else that
speaks the spec. Keep skill bodies **tool-agnostic**: describe capabilities, not
a specific harness's tool names, and gate any harness-specific affordance behind
"if your harness supports X." Full directory mapping and the `npx skills`
distribution flow are in `references/cross-harness.md`.

## Anti-patterns (do not do these)

- **Mining everything.** A 40-skill dump is noise. Ship the top band; defer the
  rest in the report. Fewer, sharper skills beat a sprawling pile.
- **Re-implementing the ecosystem.** If `find-skills` shows a maintained skill,
  REUSE it. Bespoke is a cost, not a badge.
- **Generic skills.** "Write good tests" is not a mined skill. "Run `pnpm
  test:int`; integration tests live in `tests/integration` and need `.env.test`
  with port 5441" is.
- **Silent truncation.** If you cap candidates or skip a subsystem, say so in the
  report. A bounded pass that reads as exhaustive is a lie.
- **Unverifiable skills.** If an agent can't tell whether it followed the skill,
  the skill can't improve. Add a check.
- **Self-grading.** Letting the agent that proposed or wrote something also judge
  it. Scores inflate and skills look better than they are. The Gate A/B reviewers
  must be independent and prompted to refute — see
  `references/adversarial-review.md`.

## Verification checklist

Before declaring done:

- [ ] Every candidate appears in `SKILLS_MINED.md` with score + decision.
- [ ] Each BUILD candidate survived **Gate A** (independent skeptic); revised
      scores + strongest objection recorded.
- [ ] Each built skill survived **Gate B** (cold red-team) with "used it, it
      worked" evidence — not a self dry-run.
- [ ] Adversarial reviewers were independent (fresh context, refute-by-default).
- [ ] Each BUILT skill has valid frontmatter and a trigger-rich description.
- [ ] Each skill shows real repo commands/paths, not generic advice.
- [ ] Reused skills are named with their source package.
- [ ] *(unless `--no-agents`)* Agents name the specific skills they load.
- [ ] *(unless `--no-team`/`--no-agents`)* The team manifest lists the roster,
      each persona's skills, and the handoff order.
- [ ] Any excluded output (`--no-agents`/`--no-team`) is noted in the report.
- [ ] Install instructions are present and correct for the user's harness.
