# Contributing

## Development setup

```bash
git clone https://github.com/voodootikigod/skill-mining.git
cd skill-mining
node --version  # must be >= 20
```

No `npm install` step required — the project has zero runtime and dev dependencies. `node --test` uses Node's built-in test runner and all imports are relative to `src/`, so tests run directly from the clone.

## Running tests

```bash
npm test
```

Uses Node's built-in test runner (`node:test`). No external framework needed.

## Project layout

```
bin/cli.js          — CLI entry point (mine + validate commands)
src/                — core modules (survey, phases, gates, dedupe, llm, ...)
skill-mining/       — the SKILL.md artifact (what gets installed in harnesses)
test/               — unit tests, one file per src module
```

## Making changes

1. Write tests first (see `test/` for patterns using `node:test`).
2. Make your change in the appropriate `src/` module.
3. Run `npm test` — all tests must pass.
4. Update `skill-mining/SKILL.md` if the user-facing behavior changes.
5. Update `CHANGELOG.md` under an `[Unreleased]` section.

## Submitting a pull request

- Keep PRs focused — one logical change per PR.
- Describe the *why* in the PR description, not just the *what*.
- Reference any related issues.

## Reporting bugs

Open an issue at <https://github.com/voodootikigod/skill-mining/issues>.
Include the command you ran, the Node version, and the error output.
