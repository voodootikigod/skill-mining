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
read — and let the package manager fan out copies.

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
