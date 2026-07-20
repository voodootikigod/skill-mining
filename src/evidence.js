import { log } from "./utils.js";

// Token shapes that look like repo paths: contains a slash, or a known file
// extension. Deliberately loose — verification, not parsing.
const PATH_TOKEN_RE = /(?:[\w@.-]+\/)+[\w@.*-]+|\b[\w.-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|md|py|go|rs|rb|java|kt|swift|php|yml|yaml|toml|sh|sql|env|lock|gradle|xml)\b/g;

const HEX_SHA_RE = /^[0-9a-f]{7,40}$/i;
const URL_RE = /:\/\//;

/**
 * Extract path-like tokens from free text (candidate evidence/examples).
 * Filters out URLs, commit SHAs, version pins, and glob-only tokens.
 */
export function extractPathTokens(text) {
  // Strip URLs first — the token regex would otherwise capture their path
  // part. Then drop glob tokens wholesale BEFORE matching: PATH_TOKEN_RE
  // would otherwise consume "src/**" of "src/**/*.test.js" and re-match the
  // leftover "*.test.js" as a clean-looking "test.js" token. Markdown
  // emphasis is unwrapped, not dropped — both a fully self-wrapped token
  // (**src/app.js**) and a marker attached to one edge of a multi-word span
  // ("**src/app.js is the hotspot**" leaves the token "**src/app.js").
  // Edge markers are stripped only where they abut a word character: glob
  // asterisks abut '.', '/', or '*' ("*.test.js", "src/**") and must survive
  // into the glob check so the whole token is still dropped.
  const stripped = (text || "")
    .replace(/\bhttps?:\/\/\S+/gi, " ")
    .replace(/\S+/g, (tok) => {
      if (!tok.includes("*")) return tok;
      const emphasis = tok.match(/^(\*{1,3})([^*]+)\1([.,;:)\]]*)$/);
      if (emphasis) return emphasis[2] + emphasis[3];
      const unwrapped = tok
        .replace(/^\*{1,3}(?=[^*./])/, "")
        .replace(/(?<=[^*./])\*{1,3}(?=[.,;:)\]]*$)/, "");
      return unwrapped.includes("*") ? " " : unwrapped;
    });
  const matches = stripped.match(PATH_TOKEN_RE) || [];
  const tokens = matches
    .map(t => t.replace(/[.,;:)\]]+$/, "")) // trailing punctuation
    .filter(t => !URL_RE.test(t))
    .filter(t => !HEX_SHA_RE.test(t))
    .filter(t => !t.includes("*"))           // globs aren't checkable paths
    .filter(t => !/^[\w.-]+@[\d.]+/.test(t)) // package@version pins
    .filter(t => t.length > 2);
  return [...new Set(tokens)];
}

/**
 * Deterministic evidence verification (no LLM): for every candidate, check
 * that the file paths it cites actually exist in the surveyed file list.
 * Fabricated evidence is the cheapest hallucination to catch — do it before
 * the gates spend tokens on it.
 *
 * Returns new candidate objects annotated with:
 *   evidenceVerified: true | false
 *   evidenceNotes: human-readable summary (verified / fabricated / uncheckable)
 */
export function verifyCandidateEvidence(candidates, allPaths) {
  const pathSet = new Set(allPaths);
  const dirSet = new Set();
  for (const p of allPaths) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) {
      dirSet.add(parts.slice(0, i).join("/"));
    }
  }

  const exists = (token) => {
    const t = token.replace(/^\.\//, "").replace(/\/+$/, "");
    return pathSet.has(t) || dirSet.has(t);
  };

  return candidates.map(cand => {
    const tokens = extractPathTokens(`${cand.evidence || ""} ${cand.example || ""}`);

    if (tokens.length === 0) {
      return {
        ...cand,
        evidenceVerified: false,
        evidenceNotes: "no checkable file paths cited — evidence is unverifiable",
      };
    }

    const missing = tokens.filter(t => !exists(t));
    if (missing.length === 0) {
      return {
        ...cand,
        evidenceVerified: true,
        evidenceNotes: `all ${tokens.length} cited path(s) exist in the repo`,
      };
    }

    return {
      ...cand,
      evidenceVerified: false,
      evidenceNotes: `cited path(s) not found in repo: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` (+${missing.length - 5} more)` : ""}`,
    };
  });
}

// Log a one-line summary of the verification pass
export function logEvidenceSummary(verifiedCandidates) {
  const flagged = verifiedCandidates.filter(c => !c.evidenceVerified);
  if (flagged.length === 0) {
    log.step("Evidence verification: all candidates cite real repo paths");
  } else {
    log.warn(`Evidence verification: ${flagged.length}/${verifiedCandidates.length} candidate(s) cite unverifiable or missing paths`);
    for (const c of flagged) {
      log.substep(`${c.name}: ${c.evidenceNotes}`);
    }
  }
}
