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

You can run skill-mining either **programmatically via CLI** in your terminal, or **conceptually** inside any agent harness loading the skill.

### 1. Programmatically via CLI

You can run skill-mining programmatically in two ways:

#### Option A: Zero-Install via npx (Recommended)

Run `npx skill-mining mine` directly inside any repository. It scans the files, runs the mining loop, and generates all artifacts on demand without needing a local install.

First, set your LLM API key (Anthropic is default; Gemini and OpenAI are also supported):

```bash
# Set your API key
export ANTHROPIC_API_KEY="your-anthropic-key"

# Run the CLI in the current directory
npx skill-mining mine
```

For other providers:
```bash
# Gemini
export GEMINI_API_KEY="your-gemini-api-key"
npx skill-mining mine --provider gemini

# OpenAI
export OPENAI_API_KEY="your-openai-key"
npx skill-mining mine --provider openai
```

#### Option B: From a Local Clone / Source Checkout

If you want to run the tool from source (e.g., to inspect code, make local modifications, or run offline), clone the repository and run the CLI directly using Node.js:

```bash
# Clone the repository
git clone https://github.com/voodootikigod/skill-mining.git
cd skill-mining

# Set your API key
export ANTHROPIC_API_KEY="your-anthropic-key"

# Run the CLI, specifying the path to your target repository
node bin/cli.js mine /path/to/target-repository
```

You can pass the same options (like `--provider`, `--model`, or `--offline`) to `node bin/cli.js`. For example:
```bash
node bin/cli.js mine /path/to/target-repository --provider gemini
```




### 2. Inside an Agent Harness

If you installed this as an agent skill, simply prompt your agent:

```
mine this repo for skills
```

---

### The Loop & Outputs

The loop executes a seven-phase process with two adversarial gates — **Survey → Detect → Score → ⟂Challenge → Dedupe → Author → ⟂Red-team → Compose → Verify & Report** — and writes:

1. **Mined skills** — one `SKILL.md` per kept candidate written to `.agents/skills/<name>/SKILL.md`.
2. **Mined agents** — persona definitions (implementer, fixer, reviewer, migrator) written to `.agents/agents/<name>.md`.
3. **`SKILLS_MINED.md`** — a synthesis report in the root with the ledger, fingerprints, and the **team manifest** wiring the handoff loop.

### CLI & Agent Options

Defaults give you the full output (skills + agents + team manifest). Flags only *remove* work:

| Flag / Option | Effect |
|---|---|
| *(none)* | Mine skills **and** agents, composed **as a team**. |
| `--no-agents` / `--skills-only` | Mine skills only; skip agents + team. |
| `--no-team` | Build agent personas, but standalone — no handoffs/manifest. |
| `--agents-only` | Recompose agents + team from already-mined skills (requires previous run). |
| `--report-only` | Re-emit `SKILLS_MINED.md` report from prior results; author nothing. |
| `--offline` | Allow registry search failure during deduplication (marks skills as `reuse-unchecked`). |
| `--provider <name>` | Force LLM provider (`anthropic`, `gemini`, `openai`) or a local CLI agent command (`claude`, `codex`, `agy`, `gemini`). |
| `--model <name>` | Force one LLM model for every phase (sets both tiers). |
| `--model-strong <name>` | Model for judgment-heavy phases: Detect, Gates A/B, Author, Compose. Default: `claude-sonnet-4-6` (Anthropic). |
| `--model-fast <name>` | Model for mechanical phases: Score, Dedupe decision, team manifest. Default: `claude-haiku-4-5` (Anthropic). |
| `--gate-model <name>` | Separate model for the adversarial gates — pointing it at a different model/family gives the gates cross-model independence from the proposer. |
| `--help` | Show CLI help text. |

The report phase uses **no model at all** — `SKILLS_MINED.md` is rendered
deterministically from the run's structured data, and a machine-readable
`SKILLS_MINED.json` sidecar is written next to it (partial modes read the
sidecar instead of LLM-parsing markdown).

> [!NOTE]
> **Local CLI Agents**: If no API keys are configured, the CLI will automatically scan for and utilize local subscription CLI agents in the following order: `agy`, `claude` (using `claude -p` fallback if stdin fails), `codex` (using `codex exec` fallback), or `gemini`.

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
