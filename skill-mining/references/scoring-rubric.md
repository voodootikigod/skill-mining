# Scoring Rubric — Phase 3

Score every candidate on five axes, 1–5. The total ranks the backlog; the *shape*
of the scores drives the reuse-vs-build decision (Phase 4).

## Axes

### Frequency — how often is this re-used or re-derived?
- **5** Touched on nearly every task in the area (e.g. how to run tests).
- **3** Recurs across a subsystem.
- **1** One-off; seen once.

### Leverage — how much does encoding it save per use?
- **5** Eliminates a slow, error-prone re-derivation or prevents a class of bug.
- **3** Saves a few minutes / one round of review.
- **1** Marginal; a competent agent gets it right anyway.

### Bespokeness — how specific to *this* codebase?
- **5** Pure tribal knowledge; nothing like it exists in the ecosystem.
- **3** A community skill exists but needs a repo-specific overlay.
- **1** Fully covered by a maintained public skill.

### Stability — will it stay true?
- **5** Structural; changes only with a major rewrite.
- **3** Stable for a quarter or two.
- **1** Churns weekly; documenting it is a maintenance trap.

### Verifiability — can an agent confirm it applied the skill?
- **5** A command/output proves compliance (test passes, lint clean).
- **3** Checkable by inspection.
- **1** Purely subjective.

## Reading the scores → decision

| Pattern | Decision |
|---|---|
| High Bespokeness (4–5) **and** high Leverage (4–5) | **BUILD** — author it. |
| High Leverage, **low** Bespokeness (1–2) | **REUSE** — install the public skill. |
| High Leverage, mid Bespokeness (3) | **EXTEND** — public skill + thin overlay. |
| Low Frequency **and** low Leverage | **REJECT** — log in report, don't build. |
| Low Stability (1–2) | Defer or make the skill point at the source of truth instead of duplicating it. |

## Guardrails

- **Cap the build list.** Ship the top band (typically 5–12 skills for a repo).
  A deferred candidate in the report is a feature, not a gap.
- **Bespokeness is a cost.** Every built skill is something you now maintain.
  Bias toward REUSE; BUILD only earns its keep at high leverage.
- **Low stability is a trap.** If a "skill" will be wrong in a month, either skip
  it or have it reference the live source rather than copying values that rot.
