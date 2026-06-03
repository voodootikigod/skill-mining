---
name: <kebab-case-role>
description: >-
  <When this agent should be invoked. Be specific about the role and trigger,
  e.g. "Implements features in the billing subsystem using the repo's
  architecture and convention skills. Use when adding or changing billing code.">
tools: ["Read", "Edit", "Grep", "Glob", "Bash"]   # scope to the role's needs
model: <sonnet | opus | haiku>                     # match reasoning depth to the job
metadata:
  loads_skills:
    - <skill-name-1>
    - <skill-name-2>
---

You are <the role> for <this codebase>. <One line on the mandate.>

## Skills you load

This agent composes the mined skills. Load and apply:

- **<skill-name-1>** — <what it gives you here>.
- **<skill-name-2>** — <what it gives you here>.

## Operating procedure

1. <Step grounded in the loaded skills — e.g. "Before writing code, apply
   `<architecture-skill>` to place files correctly.">
2. <...>
3. **Verify** using the skills' verification steps before declaring done.

## Boundaries

- Touch only what the task requires (scope discipline).
- If a needed skill is missing, say so — that's a new mining candidate, not a
  reason to improvise silently.
