import { execFileSync } from "child_process";
import { log } from "./utils.js";

// Warm-up gets 60s: `npx -y skills` does a cold package fetch on first use
// (the old 10s timeout produced spurious "offline" failures that laundered
// into BUILDs). Per-candidate searches reuse the warmed cache, so 15s each
// bounds worst-case stall on a hanging registry.
const WARMUP_TIMEOUT_MS = 60000;
const SEARCH_TIMEOUT_MS = 15000;

// On Windows, `npx` is a .cmd shim that Node cannot spawn without a shell.
// shell:true is required there — which is exactly why every query is reduced
// to a strict safe charset first (see sanitizeQuery): with a shell in play,
// the arguments must already be inert.
const IS_WINDOWS = process.platform === "win32";

// Queries originate from LLM output over untrusted repo content. Reduce them
// to letters/digits/space/hyphen/dot before they go anywhere near a process —
// search relevance never needs shell metacharacters.
export function sanitizeQuery(query) {
  return (query || "").replace(/[^\w\s.-]/g, " ").replace(/\s+/g, " ").trim();
}

let warmedUp = false;

/**
 * Warm the npx cache once per run so per-candidate searches don't each pay
 * (or time out on) the cold-fetch cost. Failure here is non-fatal — the real
 * fail-closed decision happens per search.
 */
export function warmupSkillsCli() {
  if (warmedUp) return;
  warmedUp = true;
  try {
    log.step("Warming up skills CLI (npx cache)...");
    execFileSync("npx", winQuote(["-y", "skills", "--version"]), {
      stdio: "ignore",
      timeout: WARMUP_TIMEOUT_MS,
      shell: IS_WINDOWS,
    });
  } catch (err) {
    log.substep("Warm-up failed (will retry during search; fail-closed policy applies there)");
  }
}

// With shell:true Node concatenates argv with spaces and NO quoting, so a
// multi-word query would splinter into separate arguments on Windows. Quote
// each element there — safe because every untrusted element passed this way
// has already been reduced to [\w\s.-] by sanitizeQuery.
function winQuote(args) {
  return IS_WINDOWS ? args.map(a => (/\s/.test(a) ? `"${a}"` : a)) : args;
}

// No shell on POSIX (execFileSync argv). On Windows a shell is unavoidable for
// the npx .cmd shim, so the query is charset-sanitized before this point.
function runSearch(query) {
  const stdout = execFileSync("npx", winQuote(["-y", "skills", "find", sanitizeQuery(query)]), {
    stdio: ["ignore", "pipe", "ignore"],
    timeout: SEARCH_TIMEOUT_MS,
    encoding: "utf8",
    shell: IS_WINDOWS,
  });
  return stdout.trim();
}

/**
 * Build 2–3 search query variants for a candidate. A kebab-case internal name
 * alone almost never matches community packaging; add description keywords.
 */
export function buildSearchQueries(candidate) {
  const queries = [sanitizeQuery(candidate.name.replace(/-/g, " "))];

  const desc = sanitizeQuery(
    (candidate.description || "")
      .replace(/^use when/i, "")
      .split(/\s+/)
      .filter(w => w.length > 3)
      .slice(0, 6)
      .join(" ")
  );
  if (desc && desc.toLowerCase() !== queries[0].toLowerCase()) {
    queries.push(desc);
  }

  return queries.filter(Boolean);
}

/**
 * Searches the skills ecosystem for matching skills using multiple query
 * variants. If the search fails (e.g. offline, registry down):
 *   - If offlineAllowed is true, returns { success: false, status: "offline" }
 *   - If offlineAllowed is false, throws a fail-closed error.
 */
export function findEcosystemSkills(candidate, offlineAllowed = false) {
  warmupSkillsCli();

  const queries = typeof candidate === "string"
    ? [candidate]
    : buildSearchQueries(candidate);
  const name = typeof candidate === "string" ? candidate : candidate.name;

  log.step(`Searching ecosystem for "${name}" (${queries.length} query variant(s))...`);

  const sections = [];
  const ranQueries = [];
  const failedQueries = [];
  let lastError = null;

  for (const query of queries) {
    try {
      const output = runSearch(query);
      ranQueries.push(query);
      sections.push(`--- query: "${query}" ---\n${output || "(no results)"}`);
    } catch (err) {
      lastError = err;
      failedQueries.push(query);
      sections.push(`--- query: "${query}" ---\n(search failed)`);
    }
  }

  if (ranQueries.length > 0) {
    // "partial" (some variants failed) is distinct from "online" (all ran).
    // A name-variant failure can hide a community match the description
    // variant won't surface — the dedupe step must not launder it into a
    // clean "no match → BUILD".
    const partial = failedQueries.length > 0;
    log.substep(`Search ${partial ? "partial" : "complete"} (${ranQueries.length}/${queries.length} variant(s) ran)`);
    return {
      success: true,
      status: partial ? "partial" : "online",
      queries,
      ranQueries,
      failedQueries,
      results: sections.join("\n\n"),
    };
  }

  if (offlineAllowed) {
    log.substep("All search variants failed/offline. Offline mode enabled, so proceeding.");
    return {
      success: false,
      status: "offline",
      queries,
      results: "",
    };
  }

  log.error(`Ecosystem search failed for "${name}" (registry unreachable or timeout).`);
  throw new Error(
    `FAIL CLOSED: Could not connect to the skills registry for deduplication` +
    `${lastError ? ` (${lastError.message})` : ""}. ` +
    `To run without a network connection, pass the --offline flag (this will mark built skills as "reuse-unchecked").`
  );
}

/**
 * Run the ecosystem search for every skill candidate that might be built.
 * Runs BEFORE Gate A so the skeptic attacks bespokeness with real search
 * results instead of model memory. Returns a map: name → search result.
 *
 * One candidate's transient search failure must not discard the whole run's
 * upstream LLM work: in online mode a failed search degrades that candidate
 * to status "failed" (the dedupe decision then DEFERs it as reuse-unchecked —
 * never BUILD on a failed search), instead of aborting the batch.
 */
export function searchForCandidates(candidates, offlineAllowed = false) {
  const results = {};
  let attempted = 0;
  let failed = 0;

  for (const cand of candidates) {
    if (cand.type === "agent") continue;
    if (cand.decision === "REJECT" || cand.decision === "DEFER") continue;
    attempted++;
    try {
      results[cand.name] = findEcosystemSkills(cand, offlineAllowed);
    } catch (err) {
      failed++;
      log.warn(`Reuse search failed for "${cand.name}" — it will be DEFERRED (reuse-check unavailable), not built.`);
      results[cand.name] = { success: false, status: "failed", queries: [], results: "" };
    }
  }

  // One transient failure degrades that candidate (handled above). But if
  // EVERY search failed in non-offline mode, the registry is provably
  // unreachable — honor the fail-closed contract instead of shipping a
  // "success" report where every candidate silently deferred.
  if (!offlineAllowed && attempted > 0 && failed === attempted) {
    throw new Error(
      `FAIL CLOSED: every ecosystem reuse search failed (${failed}/${attempted}) — the skills registry is unreachable. ` +
      `Re-run with --offline to build anyway (skills will be marked "reuse-unchecked" and re-checked on the next online pass).`
    );
  }

  return results;
}
