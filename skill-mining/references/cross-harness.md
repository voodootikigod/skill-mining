# Cross-Harness Portability

Skills authored by skill mining use the open `SKILL.md` format and are designed
to load in any compliant agent harness. This file covers where artifacts go and
how they're distributed.

## The open format

A skill is a directory containing a `SKILL.md` with YAML frontmatter:

```yaml
---
name: kebab-case-unique-name
description: Trigger-rich one-liner; how the skill is discovered.
license: MIT            # optional but recommended for published skills
user-invocable: true    # optional; can be run as a command
---
# Body — capability instructions, tool-agnostic.
```

Optional supporting files (`references/`, `scripts/`, `templates/`) travel with
the skill and are loaded on demand (progressive disclosure).

## Directory mapping per harness

`npx skills` installs into the right place automatically. For manual installs:

| Harness | Skills directory |
|---|---|
| **Cross-harness (neutral)** | `.agents/skills/<name>/` |
| **Claude** (Code/Desktop) | `.claude/skills/<name>/` or `~/.claude/skills/<name>/` |
| **Codex** | `.codex/skills/<name>/` (and discoverable via `AGENTS.md`) |
| **Antigravity** | `.agents/skills/<name>/` (reads the neutral location) |
| **Cursor** | `.cursor/skills/<name>/` |
| **Zed** | `.zed/skills/<name>/` |

When in doubt, author into `.agents/skills/` — the neutral location most harnesses
read — and let the package manager fan out copies. The CLI writes to `.agents/`
by default; pass `--out-dir <dir>` to target a harness directory directly (e.g.
`--out-dir .claude` writes `.claude/skills/<name>/` and `.claude/agents/<name>.md`).
`SKILLS_MINED.md`/`.json` stay at the repo root either way.

## Agents and team manifests per harness

Skills are portable as-is. **Agent definitions are not** — `tools` and `model`
fields are harness-specific, so a Claude-shaped agent is ignored or rejected
elsewhere. Author the **portable core** (name, description, `loads_skills`,
neutral `capabilities`) once, then render the harness overlay only for the target.

> **Manual step / roadmap.** The CLI emits **portable definitions only**
> (`.agents/agents/<name>.md` — no `tools`, no `model`). The harness overlays
> below — `.claude/agents/<name>.md` with `tools`/`model` fields, the `.codex`
> TOML role config, Cursor/Zed registrations — are a manual translation today;
> automating them is roadmap, not shipped. Use the tables in this file as the
> translation guide. `--out-dir` only relocates the portable artifacts into a
> harness tree; it does not add harness-specific fields.

| Harness | Where a runnable role is registered | `tools` / `model` |
|---|---|---|
| **Claude** | `.claude/agents/<name>.md` | `tools: [Read, Edit, Grep, Glob, Bash]`; `model: sonnet\|opus\|haiku` |
| **Codex** | `[agents.<name>]` in Codex config → `.codex/agents/<role>.toml` (repo-local) or `~/.codex/agents/`. `AGENTS.md` is **context prose only**, not where roles/permissions register. | translate `capabilities`; model + permissions in the role's TOML/config |
| **Cursor** | `.cursor/agents/` (or rules) | Cursor tool vocabulary |
| **Zed** | `.zed/agents/` | Zed tool vocabulary |
| **Neutral** | `.agents/agents/<name>.md` | omit `tools`/`model`; keep `capabilities` |

**Capability → tool translation matrix.** When you render a harness overlay, map
each neutral capability to the concrete representation below. `omit` means the
harness infers the tool automatically — emit nothing for that capability.

| Neutral capability | Claude (`tools:`) | Codex | Cursor | Zed | Neutral |
|---|---|---|---|---|---|
| read files | `Read` | omit (default) | omit (default) | omit (default) | omit |
| edit files | `Edit` (+ `Write` to create) | `edit` permission in the role's `.codex/agents/<role>.toml` / `[agents.<name>]` config | enable Edit in agent rules | enable edit | omit |
| search code | `Grep`, `Glob` | omit (default) | omit (default) | omit (default) | omit |
| run shell commands | `Bash` | `shell`/`exec` permission in the role's `.codex/agents/<role>.toml` / `[agents.<name>]` config | enable Terminal/Run | enable terminal | omit |
| fetch web / docs | `WebFetch`, `WebSearch` | tool/plugin if enabled | enable web | enable web | omit |
| **model selection** | `model: sonnet\|opus\|haiku` | set in Codex config, not the agent file | model picker / rules | settings | omit |

Notes: Codex generally **infers** read/search from the task and gates **edit/shell
via role config**. Register a runnable role with an `[agents.<name>]` entry in
Codex config pointing at a `.codex/agents/<role>.toml` (repo-local) or
`~/.codex/agents/` layer — that TOML carries the model and edit/shell permissions.
`AGENTS.md` is optional context prose; roles written there are **not** registered
as runnable agents. Cursor/Zed enable tools through agent/rules UI rather than a
frontmatter list; the `capabilities` list is your checklist of what to switch on.

The **team manifest** is plain Markdown (a table + handoff order) and lives in
`SKILLS_MINED.md` — portable everywhere. Only the per-persona agent files carry
harness-specific fields.

## Keep skill bodies tool-agnostic

Portability comes from *what you write*, not just where you put it:

- Describe **capabilities**, not a specific harness's tool names. Say "search the
  codebase," not "use the Grep tool."
- Gate harness-specific affordances behind a conditional: "If your harness
  supports parallel subagents (Claude Workflow, Codex parallel tasks), fan out;
  otherwise iterate sequentially."
- Reference commands the user runs in a shell (`npx skills find`, `pnpm test`) —
  these are universal.

## Distribution via skills.sh

The Skills CLI is the package manager for the open ecosystem:

```bash
npx skills find <query>        # discover skills
npx skills add <user/repo>     # install from GitHub (this repo: voodootikigod/skill-mining)
npx skills check               # check for updates
npx skills update              # update installed skills
```

Browse and rank skills at <https://skills.sh>.

### Publishing a mined skill

1. Put each skill in its own folder with a `SKILL.md` at the folder root.
2. Add a top-level `LICENSE` (MIT recommended for community skills).
3. Push to a public GitHub repo.
4. Users install with `npx skills add <user>/<repo>`; it appears on the
   skills.sh leaderboard as installs accrue.
