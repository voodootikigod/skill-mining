---
name: <kebab-case-name>
description: >-
  <Trigger-rich one-liner. Pack the phrases a user would actually say when they
  need this. Start with "Use when ...". This is how the skill is discovered —
  write it LAST, after the body, and make it concrete to this repo.>
license: MIT
user-invocable: true
metadata:
  version: 1.0.0
  source: mined from <repo-name>
  evidence: <files/commits that prove this pattern recurs>
---

# <Skill Title>

<One paragraph: what this skill does and why it matters in THIS codebase. Name
the real subsystem, the real pain it removes.>

## When to use

- <Concrete trigger 1>
- <Concrete trigger 2>

## The procedure

<Numbered, specific steps. Use the repo's REAL commands and paths, not generic
advice. Example:>

1. Run `pnpm --filter @app/web test:int` from the repo root.
2. Integration tests live in `tests/integration` and require `.env.test` with
   `DATABASE_PORT=5441`.
3. <...>

## Conventions / rules

<The invariants a senior engineer here would enforce. Be specific.>

## Verification

<How an agent confirms it applied this skill correctly — a command to run, an
output to expect. If this section is empty, the skill is not done.>

## References (optional, progressive disclosure)

- `references/<long-checklist>.md` — loaded on demand.
