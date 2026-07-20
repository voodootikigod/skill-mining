---
name: safe-subprocess-invocation
description: >-
  Use when spawning any child process in this codebase — npx skills searches in
  src/dedupe.js, git commands in src/survey.js, or local LLM CLIs (claude,
  codex, agy, gemini) in src/llm.js. Covers execFile-with-argv over shell
  strings, the Windows .cmd shim that forces shell:true, sanitizeQuery-before-
  winQuote ordering, warmup vs per-search timeouts, stdin.end() to prevent npx
  hangs, and NUL-safe git path listing.
license: MIT
user-invocable: true
metadata:
  version: 1.0.1
  source: mined from skill-mining
  evidence: >-
    src/dedupe.js (sanitizeQuery, winQuote, WARMUP_TIMEOUT_MS/SEARCH_TIMEOUT_MS,
    stdin.end; 2 bug-fix commits), src/llm.js (isCmdInstalled charset guard,
    execCliIgnoringStderr, buildCliArgv, callCliLLM),
    src/survey.js (git -c core.quotepath=false ls-files -z)
---

# Safe Subprocess Invocation

Every external process this CLI spawns — `npx -y skills find` during dedupe,
`git` during survey, and local agent CLIs (`claude`, `codex`, `agy`, `gemini`)
as LLM fallbacks — carries the same three risks: shell injection from
LLM-derived strings, Windows `.cmd` shim spawn failures, and hangs that launder
into wrong pipeline decisions (a timed-out registry search once read as "no
duplicate exists" and produced spurious BUILDs). `src/dedupe.js` has two
bug-fix commits paying for these lessons. This skill encodes the exact
spawn pattern so new subprocess call sites don't re-hit them.

## When to use

- Adding or modifying any `spawn`/`execFile`/`execSync` call in `src/`.
- Passing an LLM-generated or repo-derived string (search query, package ref,
  file path) into a child process argument.
- Debugging "works on macOS, fails on Windows" spawn errors (`ENOENT` on
  `npx`/`claude` — they are `.cmd` shims there).
- A subprocess call that hangs forever or times out intermittently in CI.
- Listing repo files for the survey phase (paths with spaces/unicode).

## The procedure

1. **Default: `execFile` with an argv array, no shell.** Follow
   `src/dedupe.js`:

   ```js
   import { execFile } from "child_process";
   import { promisify } from "node:util";
   const execFileAsync = promisify(execFile);
   await execFileAsync("npx", ["-y", "skills", "find", query], { timeout: SEARCH_TIMEOUT_MS });
   ```

   Never interpolate arguments into a command string; never pass `shell: true`
   on POSIX. For local agent CLIs, build the argv with `buildCliArgv` in
   `src/llm.js` (e.g. `buildCliArgv("codex", model)` →
   `["codex", "exec", "-m", model]`) — the prompt itself never goes in the
   argv on the primary path; it travels via stdin (Step 5).

2. **Sanitize untrusted strings BEFORE they touch any spawn call.** Queries in
   the dedupe phase originate from LLM output over untrusted repo content.
   Route them through `sanitizeQuery` from `src/dedupe.js`, which strips to
   `[\w\s.-]`:

   ```js
   export function sanitizeQuery(query) {
     return (query || "").replace(/[^\w\s.-]/g, " ").replace(/\s+/g, " ").trim();
   }
   ```

   Search relevance never needs shell metacharacters, so reduce — don't
   escape. For package refs, gate on `isSafePackageRef` from `src/utils.js`
   instead. For model names reaching agent CLIs, gate with
   `assertSafeModelName` from `src/llm.js` at configuration time.

3. **Windows: `shell: true` only where the `.cmd` shim forces it.** Node
   cannot spawn `npx` (a `.cmd` shim) without a shell on Windows. Gate on
   `IS_WINDOWS` (`process.platform === "win32"`), and because a shell is now
   in play, the ordering is mandatory: `sanitizeQuery` first, then wrap
   multi-word args with `winQuote`. Sanitization makes the string inert;
   quoting only keeps it one argument. Quoting an unsanitized string is the
   bug class the fix commits in `src/dedupe.js` paid for. In `src/llm.js`,
   `callCliLLM` follows the same rule: `shell: isWindows`, with the argv
   holding only flags plus a charset-validated model name — the untrusted
   prompt travels via stdin, never through the shell.

4. **Differentiate cold-start and steady-state timeouts.** `npx -y skills`
   does a cold package fetch on first use; the old flat 10s timeout produced
   spurious "offline" failures that laundered into BUILD decisions. Follow the
   `src/dedupe.js` constants:

   ```js
   const WARMUP_TIMEOUT_MS = 60000;  // one cold-fetch warmup per run
   const SEARCH_TIMEOUT_MS = 15000;  // per-search, cache already warm
   ```

   Run the warmup exactly once behind a shared module-level promise
   (`warmupPromise` / `warmupSkillsCli`) so concurrent searches all await the
   same warm-up and none pays the cold cost. Warmup failure is non-fatal; the
   fail-closed decision happens at search time. These two constants are
   registry-search budgets in `src/dedupe.js` — they are NOT the right budget
   for agent CLI calls in `src/llm.js` (see Conventions for that class).

5. **Always close stdin on CLIs that may wait for input.** `npx` (and the
   local agent CLIs) can block forever reading stdin. After spawning, call
   `child.stdin.end()` — or use `stdio: ["pipe", ...]` and end the pipe —
   before awaiting output. For CLIs that consume the prompt via stdin
   (`claude -p`, `codex exec`), write the prompt first, then end — never end
   before writing, or the CLI sees an empty prompt and hangs or returns
   nothing; `child.stdin.end(promptString)` does write-then-end atomically,
   and that is exactly how `callCliLLM` in `src/llm.js` delivers prompts
   (with a POSIX-only positional-argument fallback for CLIs that don't read
   stdin — never on Windows, where that would route untrusted content
   through a shell). If you route through `execCliIgnoringStderr`, see
   Step 6: stdin is already written-and-closed for you — do not call
   `stdin.end()` again. A missing `stdin.end()` presents as a timeout, not
   an error, which is why it goes unnoticed until CI.

6. **Ignore stderr at the fd level for chatty CLIs.** Promisified `execFile`
   buffers stderr and enforces `maxBuffer` on it, so a CLI writing >10MB of
   spinner logs to stderr kills an otherwise-successful call. Use
   `execCliIgnoringStderr` in `src/llm.js`. Its exact contract:

   ```js
   execCliIgnoringStderr(binary, args, { input, shell = false, maxBuffer = 10 * 1024 * 1024 })
   ```

   - Spawns with `stdio: ["pipe", "pipe", "ignore"]` — stderr is discarded at
     the fd level and never counted against any buffer.
   - Immediately writes `input` (the prompt, or `""` if omitted) to the
     child's stdin and ends it: `child.stdin.end(input ?? "")`. Step 5 is
     satisfied when you use it — do not call `stdin.end()` again. An EPIPE
     from a child that exits without reading stdin is swallowed so failure
     surfaces as the exit code, not a stream error.
   - Bounds only stdout at `maxBuffer` (10MB default). Resolves with the
     stdout **string** on exit code 0; rejects on non-zero exit, spawn
     error, or stdout overflow.
   - It does **NOT** accept a timeout and will never kill a hung child on
     its own. The caller must add the timeout: extend the helper with a
     `timeoutMs` option that triggers its internal `fail()` (which kills the
     child) on expiry, driven by `LLM_CLI_TIMEOUT_MS` (see Conventions). A
     bare `Promise.race` wrapper is not enough — it leaves the child process
     running.
   - `shell` exists solely for the Windows `.cmd` branch (Step 3).

   Do not replace it with `execFileAsync` "for simplicity."

7. **Guard existence checks too.** `isCmdInstalled` in `src/llm.js`
   charset-guards the binary name (`/^[\w.-]+$/`) before running
   `command -v ${cmd}` via `execSync` — an existence probe is still a
   subprocess taking a string. Reuse it rather than shelling out `which` ad
   hoc. Know its Windows behavior explicitly: it does NOT branch on
   `IS_WINDOWS`. `command -v` is a POSIX shell builtin; on win32 `execSync`
   uses cmd.exe, where `command` doesn't exist, so the probe fails and
   `isCmdInstalled` returns `false` for every binary on Windows. The charset
   guard therefore covers injection everywhere, but detection itself is a
   known gap on Windows — CLIs there are `.cmd` shims and simply report as
   not installed. If a new call site needs Windows detection, add an
   `IS_WINDOWS` branch inside `isCmdInstalled` using `where <cmd>` with the
   same charset guard already applied; never weaken or bypass the guard.

8. **Git paths: NUL-delimited, quotepath off.** For file listing in
   `src/survey.js` use:

   ```js
   execSync("git -c core.quotepath=false ls-files -z", { cwd: targetPath })
   ```

   and split on `\0`. Without `core.quotepath=false` git octal-escapes
   unicode paths; without `-z`, paths containing newlines corrupt the list.

## Conventions / rules

- `shell: true` appears in exactly two situations, both Windows `.cmd`
  shims: the `IS_WINDOWS`-gated npx call in `src/dedupe.js` and
  `shell: isWindows` in `callCliLLM` (`src/llm.js`). Any other use is a
  review blocker.
- Sanitize (reduce to a safe charset) before quoting — quoting is not
  sanitization. `sanitizeQuery` → `winQuote`, never `winQuote` alone.
- Every subprocess call gets an explicit timeout; cold-start paths get their
  own larger budget. Registry searches: `WARMUP_TIMEOUT_MS = 60000` /
  `SEARCH_TIMEOUT_MS = 15000` in `src/dedupe.js`. Local agent CLI
  invocations: `src/llm.js` currently defines NO timeout constant and
  `execCliIgnoringStderr` accepts none — for any new agent-CLI call site
  (e.g. `codex exec`), define `LLM_CLI_TIMEOUT_MS = 300000` (5 min)
  alongside the existing `MAX_OUTPUT_TOKENS` constant in `src/llm.js` and
  enforce it by killing the child (Step 6). Agent CLIs generate long
  outputs and need a far larger budget than a 15s registry search — do not
  reuse `SEARCH_TIMEOUT_MS`.
- A failed/timed-out search must fail closed (recorded as `reuse-unchecked`
  under `--offline`, otherwise an error) — never interpreted as "no results."
- Bound stdout with `maxBuffer`; discard stderr at the fd level for CLIs you
  don't control.
- New spawn logic gets tests next to the existing ones: `test/dedupe.test.js`
  covers sanitization/timeout behavior, `test/llm.test.js` covers CLI
  execution.

## Verification

1. Run the focused suites: `node --test test/dedupe.test.js test/llm.test.js`
   (or `npm test` for all) — all pass.
2. New CLI call sites need tests, and `test/llm.test.js` never spawns real
   CLIs — write yours through its three existing seams: argv construction is
   unit-tested via the exported `buildCliArgv` (asserting exact arrays, e.g.
   `["codex", "exec", "-m", "o3"]`); `llmCall` control flow is tested via the
   `config.caller` injection seam (pass a config whose `caller` is a scripted
   async function — production configs from `configureLLM` never set it); API
   providers are tested by replacing `globalThis.fetch` with a stand-in
   Response. Assert your new call's argv shape and timeout constant the same
   way.
3. Grep for unsafe patterns and confirm zero hits outside the two Windows
   branches:
   - `grep -rn "shell: true" src/` → only the `IS_WINDOWS`-gated npx call in
     `src/dedupe.js`; `grep -rn "shell: isWindows" src/` → only `callCliLLM`
     in `src/llm.js`.
   - `grep -rn "execSync(\`" src/` and template-literal interpolation into
     any spawn call → none with untrusted input.
4. For any new call site, confirm: argv array (not command string), explicit
   timeout constant (`LLM_CLI_TIMEOUT_MS` for agent CLIs), sanitization or
   charset-gating applied before the string leaves your code, and stdin
   handled — either `execCliIgnoringStderr` (which writes-and-closes it for
   you) or an explicit `stdin.end()` after writing any stdin-delivered
   prompt.