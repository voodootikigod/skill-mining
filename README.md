# Skill Mining

> Point an agent at a codebase and ask: *what reusable skills and agents are
> latent in here that would make every future change faster, more accurate, and
> easier to maintain?* Then extract them as durable artifacts that ship with the
> repo and get sharper every time they're used.

**Skill mining** is a repeatable loop for turning the institutional knowledge
buried in a codebase — the build incantations, domain rules, conventions, review
checklists, and deploy recipes that everyone re-derives — into a portfolio of
**agent skills** (`SKILL.md` files) and **agent definitions** that compose them.

This repo packages skill mining as an open, cross-harness **agent skill**. It
works in Claude, Codex, Antigravity, Cursor, Zed, and any harness that speaks the
open `SKILL.md` format.

## Install

```bash
npx skills add voodootikigod/skill-mining
```

Or copy `skill-mining/` into your harness's skills directory (see
[`skill-mining/references/cross-harness.md`](skill-mining/references/cross-harness.md)).

### Companion skill (recommended, not required)

The reuse-before-build step (Phase 4) is the defense against **skill sprawl**. It
runs on the `skills` CLI, which is **zero-install** — `npx skills find …` fetches
it on demand, so skill-mining works out of the box.

For a smarter reuse search (leaderboard reasoning, source-trust checks), install
the companion **`find-skills`** skill:

```bash
npx skills find find-skills      # locate it, then `npx skills add <result>`
```

skill-mining degrades gracefully without it — there is no hard dependency, because
the format has no transitive-install mechanism and none is needed.

A missing companion and a failed search are different: `find-skills` being absent
just degrades to `npx skills find`, but if the **search itself fails** (offline,
registry unreachable), the loop **fails closed** — it records the reuse check as
unavailable rather than treating "couldn't search" as "nothing exists," so it
never silently builds a duplicate.

## Use

Invoke the skill against a repo:

```
mine this repo for skills
```

It runs a seven-phase loop with two adversarial gates — **Survey → Detect →
Score → ⟂Challenge → Dedupe → Author → ⟂Red-team → Compose → Verify & Report** —
and writes:

1. **Mined skills** — one `SKILL.md` per kept candidate.
2. **Mined agents** — persona definitions (implementer, fixer, reviewer,
   migrator) that compose the skills, **plus a team manifest** that wires them
   into a handoff workflow so they operate as a team, not a bag of agents.
3. **`SKILLS_MINED.md`** — a report with every candidate, its leverage score, and
   the reuse-vs-build decision.

The core idea: **reuse before you build.** Most candidates should resolve to an
existing community skill. The few that are genuinely bespoke and high-leverage
become new, repo-specific skills.

### Options

Defaults give you the full output; flags only remove work:

| Flag | Effect |
|---|---|
| *(none)* | Skills **and** agents, composed **as a team**. |
| `--no-agents` (`--skills-only`) | Mine skills only; skip agents + team. |
| `--no-team` | Build agent personas, but standalone — no handoffs/manifest. |
| `--agents-only` | Recompose agents + team from already-mined skills. |
| `--report-only` | Re-emit the report; author nothing. |

## What's in here

```
skill-mining/
├── SKILL.md                         # the mining loop (the skill itself)
└── references/
    ├── candidate-taxonomy.md        # where skills hide (the detection sweep)
    ├── scoring-rubric.md            # how to rank candidates (5 axes)
    ├── adversarial-review.md        # the two refute-by-default gates (A + B)
    ├── cross-harness.md             # format + per-harness install map
    └── templates/
        ├── skill-template.md
        ├── agent-template.md
        └── report-template.md
```

## From one repo to the whole org

Skill mining is the **repo-level** loop — one developer or team, one codebase,
run on demand.

The same shape scales up. Run it **continuously across an entire organization's
AI traffic** instead of one repository and it becomes *portfolio curation*:
detect the recurring AI work patterns across teams, match them to the capabilities
that already exist, find where people are reinventing or bypassing standards, and
build only what's genuinely missing. That loop — **detect recurring know-how →
match to what exists → find the gaps → build only what's missing → measure
coverage over time** — is what turns chaotic, expensive AI sprawl into an
intentional operating model. It's a key factor in both *agentic adoption* and *AI
financial optimization* at enterprise scale.

That enterprise-scale version is a separate effort, and there's more to share on
it soon.

## License

MIT © 2026 Chris Williams (@voodootikigod). See [LICENSE](LICENSE).
