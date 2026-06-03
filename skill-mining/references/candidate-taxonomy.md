# Candidate Taxonomy — Where Skills Hide

A sweep checklist for Phase 2 (Detect). Most teams only think of "code patterns"
as skills. The highest-leverage skills usually hide in the *operational* and
*tribal-knowledge* layers nobody wrote down. Walk every category.

## 1. Build, test & run incantations (highest hit rate, lowest effort)

The exact commands to build, test, lint, type-check, format, migrate, seed, and
run locally — including the flags, env files, and ports that make them work.
Every agent re-derives these on every task. A single accurate "how this repo
runs" skill pays back immediately.

- Monorepo task graph (`turbo`/`nx`/workspace scripts) and how to target one app
- Test tiers (unit/integration/e2e), where each lives, what each needs to pass
- The `.env.test` vs `.env.local` split, required vars, port assignments
- The "works on CI but not locally" gotchas

## 2. Domain rules & invariants

Business logic that must hold but is enforced only by scattered validators or
reviewer memory: allowed state transitions, tenancy/isolation rules, money/units
handling, PII boundaries, rate limits, idempotency requirements.

- Validation rules duplicated across boundaries
- "Never do X to Y" invariants learned from past incidents
- Canonical vocabulary / object model the code assumes

## 3. Architectural & convention patterns

The shape a new module is *supposed* to take. Currently enforced by code review;
should be a skill.

- Folder-by-feature layout, naming, file-size norms
- Data-access pattern (repository, query layer, ORM conventions)
- Error-handling and API-response envelope conventions
- Component/state/styling conventions for UI

## 4. Review checklists

Whatever reviewers reliably catch is a skill. Mine the review comments and the
revert history.

- Security review patterns specific to this stack
- Performance pitfalls this codebase repeatedly hits
- "We always forget X" classes of bug

## 5. Debugging & recovery playbooks

Known failure modes and their fixes. If the same incident recurs, the resolution
is a skill.

- Reproduce → localize → fix recipes for recurring bugs
- Flaky-test triage, lock-file/cache recovery, migration-rollback steps
- Environment/setup failure remedies

## 6. Migration & deploy recipes

Multi-step, error-prone, infrequent — exactly the things people get wrong.

- Schema migration + backfill sequences (and their safety order)
- Release/rollback procedure, feature-flag ramps, canary steps
- Dependency-upgrade playbooks

## 7. Integration & external-system know-how

How this repo talks to its dependencies: auth flows, webhook contracts, retry
and timeout conventions, provider-specific quirks.

## 8. Candidate **agents** (roles, not capabilities)

A role that orchestrates several of the above. Look for jobs-to-be-done that
recur:

- Implementer, Fixer/Debugger, Reviewer, Migrator/Operator, Onboarder
- Any "X specialist" your team wishes they could clone

## Evidence to capture per candidate

For each candidate, record the proof it recurs — this is what justifies it and
what makes the authored skill *specific* rather than generic:

- File paths / line ranges that embody the pattern
- `git log` evidence: churn count, bug-fix frequency, co-change clusters
- A representative real example (the actual command, the actual gotcha)
