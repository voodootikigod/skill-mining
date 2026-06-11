import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { log, VALID_DECISIONS, isSafePackageRef } from "./utils.js";
import { llmCall, llmCallJson, cleanJsonResponse } from "./llm.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.join(__dirname, "..");

// Helper to read markdown guidelines/templates from the package itself
export async function readPackageFile(relPath) {
  const fullPath = path.join(packageRoot, relPath);
  return await fs.readFile(fullPath, "utf8");
}

// Shared survey context block used by Detect and the Completeness Critic.
// Both must see the same evidence — the old critic saw only the candidate
// list and hotspots, which made "find what the sweep missed" impossible.
function buildSurveyContext(survey) {
  return `
Target Path: ${survey.path}
Number of files: ${survey.filesCount}

Directory shape (top-level dirs with file counts):
${survey.treeSummary || "(unavailable)"}

File extensions histogram:
${survey.extHistogram || "(unavailable)"}

File list (subset):
${survey.filesList}

Churn hotspots (most-changed files, last 500 commits):
${JSON.stringify(survey.git.hotspots, null, 2)}

Bug-fix hotspots (files most touched by fix/revert/bug commits):
${JSON.stringify(survey.git.bugFixHotspots || [], null, 2)}

Pain markers (TODO/FIXME/HACK counts per file):
${survey.painMarkers?.available ? JSON.stringify(survey.painMarkers.topFiles, null, 2) : "(unavailable)"}

Recent commit messages:
${survey.git.recentCommits.slice(0, 25).join("\n")}

Key Configurations:
${Object.entries(survey.configs).map(([pkg, text]) => `--- File: ${pkg} ---\n${text}`).join("\n\n")}

Representative source samples (for conventions, error handling, domain rules):
${Object.entries(survey.sourceSamples || {}).map(([p, text]) => `--- Sample: ${p} ---\n${text}`).join("\n\n") || "(none sampled)"}
`;
}

// ----------------------------------------------------
// Phase 1 & 2: Survey & Detect (+ Completeness Critic)
// ----------------------------------------------------
export async function runDetectPhase(llmConfig, survey) {
  log.phase("1 & 2", "Survey & Detect");

  const taxonomy = await readPackageFile("skill-mining/references/candidate-taxonomy.md");
  const skillMiningDoc = await readPackageFile("skill-mining/SKILL.md");
  const surveyContext = buildSurveyContext(survey);

  const systemInstruction = `
You are an expert AI software architect performing Phase 1 and 2 (Survey & Detect) of the Skill Mining process.
Your goal is to identify latent, high-leverage skills and agents in the codebase.
Read the Candidate Taxonomy and Skill Mining guidelines.
Cite ONLY file paths that appear in the survey — fabricated evidence is checked and flagged.
Return your findings in JSON format ONLY. Do not write any conversational text.
`;

  const prompt = `
=== Candidate Taxonomy ===
${taxonomy}

=== Skill Mining Guidelines ===
${skillMiningDoc}

=== Codebase Survey ===
${surveyContext}

=== Task ===
Based on the survey above and the taxonomy, identify:
1. Candidate skills (build commands, rules, conventions, playbooks, deploy recipes).
2. Candidate agents (roles like Implementer, Fixer, Reviewer, Migrator, etc.).

Ground every candidate in the survey: real paths from the file list/samples, real
commands from the configs, real churn/pain data. Walk EVERY taxonomy category.

Return a JSON object with this exact shape:
{
  "candidates": [
    {
      "name": "kebab-case-name",
      "description": "Trigger-rich description starting with 'Use when...'",
      "type": "skill", // or "agent"
      "evidence": "File paths, line ranges, or commit logs where this pattern is found",
      "example": "A concrete representative example (e.g. command or gotcha)"
    }
  ]
}
`;

  log.step("Calling LLM to analyze codebase and detect initial candidates...");
  const parsed = await llmCallJson(llmConfig, prompt, systemInstruction, "strong", "Detect");
  if (!Array.isArray(parsed.candidates)) {
    throw new Error("Detect phase returned no parseable candidate list (expected JSON with a `candidates` array). Re-run, or try a different --model-strong.");
  }
  log.step(`Detected ${parsed.candidates.length} initial candidates`);

  // Completeness Critic — gets the SAME survey context as Detect, plus the
  // candidate list, so it can actually name what the sweep missed.
  log.step("Running Completeness Critic...");
  const criticPrompt = `
=== Candidate Taxonomy ===
${taxonomy}

=== Codebase Survey (same evidence Detect saw) ===
${surveyContext}

=== Initial candidate list ===
${JSON.stringify(parsed.candidates, null, 2)}

=== Task ===
Assume the candidate list is incomplete. Cross-check it against every taxonomy
category and the survey evidence. Name the highest-leverage recurring knowledge
that is NOT represented — especially build/test ops, domain invariants, review
checklists, and debugging playbooks. Also list taxonomy categories where you
found nothing (negative space).

Return a JSON object with this exact shape:
{
  "newCandidates": [
    {
      "name": "kebab-case-name",
      "description": "Trigger-rich description starting with 'Use when...'",
      "type": "skill",
      "evidence": "File paths, line ranges, or commit logs where this pattern is found",
      "example": "A concrete representative example"
    }
  ],
  "emptyCategories": ["taxonomy categories with no candidates and why that seems right or wrong"]
}
If nothing is missed, return {"newCandidates": [], "emptyCategories": [...]}.
`;

  // The critic is enrichment, not load-bearing — a parse failure should not
  // abort the run, just skip the extra candidates.
  let criticParsed = { newCandidates: [], emptyCategories: [] };
  try {
    criticParsed = await llmCallJson(llmConfig, criticPrompt, systemInstruction, "strong", "Completeness Critic");
  } catch (err) {
    log.warn(`${err.message} — proceeding with the primary candidate list only.`);
  }
  const extraCandidates = Array.isArray(criticParsed.newCandidates) ? criticParsed.newCandidates : [];

  if (extraCandidates.length > 0) {
    log.step(`Completeness Critic surfaced ${extraCandidates.length} additional candidates`);
  } else {
    log.step("Completeness Critic verified candidate list is comprehensive");
  }
  if (Array.isArray(criticParsed.emptyCategories) && criticParsed.emptyCategories.length > 0) {
    log.substep(`Negative space: ${criticParsed.emptyCategories.join(" | ")}`);
  }

  // De-duplicate by name across the Detect + Critic merge — a duplicate name
  // makes the downstream by-name reconciliation lossy (later phases would map
  // both to one entry).
  const merged = [];
  const seenNames = new Set();
  for (const cand of [...parsed.candidates, ...extraCandidates]) {
    if (!cand?.name || seenNames.has(cand.name)) continue;
    seenNames.add(cand.name);
    merged.push(cand);
  }
  return merged;
}

// ----------------------------------------------------
// Phase 3: Score
// ----------------------------------------------------
export async function runScorePhase(llmConfig, candidates) {
  log.phase("3", "Score (Rank by Leverage)");

  const rubric = await readPackageFile("skill-mining/references/scoring-rubric.md");

  const systemInstruction = `
You are an expert AI software architect scoring candidate skills and agents.
Apply the Scoring Rubric strictly. Most repos yield mostly REUSE/DEFER/REJECT —
a wall of 4s and 5s means you are not discriminating.
Return your findings in JSON format ONLY. Do not write any conversational text.
`;

  const prompt = `
=== Scoring Rubric ===
${rubric}

=== Candidates ===
${JSON.stringify(candidates, null, 2)}

=== Task ===
Score each candidate on the five axes: Frequency (freq), Leverage (lev), Bespokeness (bsp), Stability (stab), and Verifiability (ver) from 1 to 5.
A candidate whose evidenceVerified field is false cannot score freq above 2 — its recurrence is unproven.
Recommend a decision based on the rubric shapes:
- BUILD: High Bespokeness (4-5) AND High Leverage (4-5).
- REUSE: High Leverage, Low Bespokeness (1-2).
- EXTEND: High Leverage, Mid Bespokeness (3).
- DEFER: Mid scores, or low Stability (1-2) — promising but not worth building this pass. Include "revisitWhen": the concrete condition that would change the decision.
- REJECT: Low Frequency and Low Leverage.

Return a JSON object with this exact shape:
{
  "scoredCandidates": [
    {
      "name": "kebab-case-name",
      "type": "skill",
      "description": "...",
      "evidence": "...",
      "example": "...",
      "scores": { "freq": 5, "lev": 4, "bsp": 3, "stab": 4, "ver": 4 },
      "decision": "BUILD",
      "revisitWhen": "only for DEFER"
    }
  ]
}
`;

  log.step("Scoring candidates against rubric...");
  const parsed = await llmCallJson(llmConfig, prompt, systemInstruction, "fast", "Score");
  if (!Array.isArray(parsed.scoredCandidates)) {
    throw new Error("Score phase returned no parseable scores (expected JSON with a `scoredCandidates` array). Re-run, or try a different --model-fast.");
  }

  // Re-attach evidence verification flags lost in the LLM round-trip. A name
  // the LLM drifted away from has no provenance — treat it as unverified
  // (fail safe), not as implicitly verified.
  const byName = new Map(candidates.map(c => [c.name, c]));
  const scored = parsed.scoredCandidates.map(s => {
    const orig = byName.get(s.name);
    if (!orig) {
      log.warn(`Score phase: candidate "${s.name}" does not match any detected candidate name — marking evidence unverified`);
    }
    return {
      ...s,
      evidenceVerified: orig?.evidenceVerified ?? false,
      evidenceNotes: orig?.evidenceNotes ?? "candidate name did not survive the scoring round-trip — provenance lost",
    };
  });

  // The ledger promises "nothing dropped silently". A candidate the scoring
  // model omitted would vanish here — carry it forward as DEFER so it appears
  // in the report and the next pass doesn't re-mine it blind.
  const scoredNames = new Set(scored.map(s => s.name));
  const dropped = candidates.filter(c => !scoredNames.has(c.name));
  for (const c of dropped) {
    log.warn(`Score phase: candidate "${c.name}" was omitted by the model — carrying forward as DEFER.`);
    scored.push({
      ...c,
      scores: { freq: 1, lev: 1, bsp: 1, stab: 1, ver: 1 },
      decision: "DEFER",
      revisitWhen: "re-run — candidate was dropped in the scoring round-trip",
      objection: "dropped in scoring round-trip",
    });
  }

  log.step(`Candidates scored successfully${dropped.length ? ` (${dropped.length} carried forward as DEFER)` : ""}`);
  return scored;
}

// ----------------------------------------------------
// Phase 3b: Score calibration (deterministic guard + comparative ranking)
// ----------------------------------------------------
const INFLATION_THRESHOLD = 0.7; // fraction of candidates with every axis ≥ 4
const MIN_FOR_RANKING = 4;

export function isScoreInflated(scoredCandidates) {
  const skills = scoredCandidates.filter(c => c.type !== "agent");
  if (skills.length < MIN_FOR_RANKING) return false;
  const inflated = skills.filter(c => {
    const s = c.scores || {};
    return ["freq", "lev", "bsp", "stab", "ver"].every(axis => (s[axis] || 0) >= 4);
  });
  return inflated.length / skills.length >= INFLATION_THRESHOLD;
}

export function totalScore(candidate) {
  const s = candidate.scores || {};
  return ["freq", "lev", "bsp", "stab", "ver"].reduce((sum, axis) => sum + (Number(s[axis]) || 0), 0);
}

/**
 * Absolute scoring in a single call drifts toward a wall of 5s. When that
 * happens, force a comparative ranking: order the BUILD/EXTEND candidates by
 * leverage and cut bands — top stays, middle defers, bottom rejects.
 */
export async function runCalibration(llmConfig, scoredCandidates) {
  if (!isScoreInflated(scoredCandidates)) {
    return scoredCandidates;
  }

  log.step("Score inflation detected (most candidates scored ≥4 on every axis) — running comparative ranking...");

  const buildLike = scoredCandidates.filter(
    c => c.type !== "agent" && (c.decision === "BUILD" || c.decision === "EXTEND")
  );
  if (buildLike.length < MIN_FOR_RANKING) return scoredCandidates;

  const prompt = `
=== Candidates (BUILD/EXTEND proposals) ===
${JSON.stringify(buildLike.map(c => ({ name: c.name, description: c.description, evidence: c.evidence })), null, 2)}

=== Task ===
Absolute scores for these came back uniformly high, which is uninformative.
Rank them COMPARATIVELY by expected leverage for agents working in this repo.
Assign each to a band: "top" (clearly worth building now), "middle" (plausible
but not this pass), "bottom" (would not miss it).
At most half may be "top".

Return JSON: { "ranking": [ { "name": "...", "band": "top" } ] }
`;

  let parsed;
  try {
    parsed = await llmCallJson(llmConfig, prompt, "Return JSON only.", "strong", "Calibration");
  } catch (err) {
    // Calibration is a guard, not load-bearing — skip it rather than abort.
    log.warn(`${err.message} — skipping comparative ranking (scores unchanged).`);
    return scoredCandidates;
  }
  const bands = new Map((parsed.ranking || []).map(r => [r.name, r.band]));
  const rankedNames = new Set(buildLike.map(c => c.name));

  // Enforce "at most half may be top" in code — calibration runs precisely
  // because the model's scores can't be trusted, so an all-top response (the
  // most likely inflation failure) must not pass through unchallenged. Demote
  // the lowest-scoring overflow tops to middle.
  const maxTop = Math.ceil(buildLike.length / 2);
  const topNames = buildLike
    .filter(c => (bands.get(c.name) || "middle") === "top")
    .sort((a, b) => totalScore(b) - totalScore(a))
    .map(c => c.name);
  if (topNames.length > maxTop) {
    log.substep(`Calibration returned ${topNames.length} "top" of ${buildLike.length} (cap ${maxTop}) — demoting the lowest-scoring overflow to middle.`);
    for (const name of topNames.slice(maxTop)) {
      bands.set(name, "middle");
    }
  }

  return scoredCandidates.map(c => {
    if (!rankedNames.has(c.name)) return c; // not part of the ranking — pass through
    // Fail safe, not fail open: a ranked candidate the LLM omitted gets no
    // implicit "top" — calibration ran because scores were uninformative.
    const band = bands.get(c.name) || "middle";
    if (band === "top") return c;
    if (band === "middle") {
      return {
        ...c,
        decision: "DEFER",
        revisitWhen: c.revisitWhen || "next mining pass, with fresh recurrence evidence",
        objection: "calibration: middle band in comparative ranking",
      };
    }
    return { ...c, decision: "REJECT", objection: "calibration: bottom band in comparative ranking" };
  });
}

/**
 * Enforce the rubric's build cap (ship the top band, typically 5–12 skills).
 * Deterministic: overflow BUILD/EXTEND skills (lowest total score first)
 * become DEFER, recorded as cap-bound in the report.
 */
export const BUILD_CAP = 12;

export function enforceBuildCap(candidates, cap = BUILD_CAP) {
  const buildLike = candidates.filter(
    c => c.type !== "agent" && (c.decision === "BUILD" || c.decision === "EXTEND")
  );
  if (buildLike.length <= cap) return candidates;

  const keep = new Set(
    [...buildLike].sort((a, b) => totalScore(b) - totalScore(a)).slice(0, cap).map(c => c.name)
  );

  return candidates.map(c => {
    const isBuildLike = c.type !== "agent" && (c.decision === "BUILD" || c.decision === "EXTEND");
    if (!isBuildLike || keep.has(c.name)) return c;
    return {
      ...c,
      decision: "DEFER",
      revisitWhen: `build cap (${cap}) reached this pass — re-rank next pass`,
      objection: c.objection || "deferred by build cap",
    };
  });
}

// ----------------------------------------------------
// Phase 4: Dedupe decision (uses search results gathered before Gate A)
// ----------------------------------------------------
export async function runDedupeDecision(llmConfig, challengedCandidates, searchResults) {
  log.phase("4", "Dedupe (Reuse-vs-build decision)");

  const finalCandidates = [];

  for (const cand of challengedCandidates) {
    if (cand.type === "agent") {
      finalCandidates.push({
        ...cand,
        source: "this repo",
        justification: "Agent role composed of skills",
        reuseCheckStatus: "n/a",
      });
      continue;
    }

    if (cand.decision === "REJECT" || cand.decision === "DEFER") {
      finalCandidates.push({
        ...cand,
        source: "n/a",
        justification: cand.decision === "DEFER" ? "Deferred during scoring/challenge" : "Rejected during scoring/challenge",
        reuseCheckStatus: "n/a",
      });
      continue;
    }

    const searchResult = searchResults[cand.name];
    if (!searchResult) {
      // No search ran for this candidate (e.g. it was DEFER/REJECT pre-Gate A
      // and Gate A upgraded it) — fail toward caution.
      log.warn(`No ecosystem search result for "${cand.name}" — deferring (reuse unchecked).`);
      finalCandidates.push({
        ...cand,
        decision: "DEFER",
        revisitWhen: "next pass with a completed reuse search",
        source: "n/a",
        justification: "Reuse search did not run for this candidate",
        reuseCheckStatus: "reuse-unchecked (no search this pass)",
      });
      continue;
    }

    // A failed or partial search is NOT "no match found". Either the whole
    // search threw (status "failed") or some query variants failed while
    // others ran (status "partial") — in both cases the reuse check is
    // incomplete and a BUILD would slip past the anti-sprawl defense. Defer.
    if (searchResult.status === "failed" || searchResult.status === "partial") {
      const failed = searchResult.failedQueries?.join(" / ") || "all variants";
      finalCandidates.push({
        ...cand,
        decision: "DEFER",
        revisitWhen: "re-run when the skills registry is reachable (reuse check incomplete this pass)",
        source: "n/a",
        justification: `Reuse search incomplete (failed: ${failed}) — reuse-check unavailable, not built`,
        reuseCheckStatus: `reuse-check-incomplete (failed variants: ${failed} @ ${new Date().toISOString()})`,
      });
      log.substep(`Final decision: DEFER (${cand.name} — reuse-check incomplete)`);
      continue;
    }

    log.step(`Deciding reuse-vs-build for: ${cand.name} (${cand.decision})`);

    let searchOutputStr;
    let reuseCheckStatus;
    if (searchResult.status === "offline") {
      reuseCheckStatus = `reuse-unchecked (offline @ ${new Date().toISOString()})`;
      searchOutputStr = "SEARCH UNAVAILABLE - RUNNING IN OFFLINE MODE";
    } else {
      reuseCheckStatus = `reuse-checked: ${searchResult.ranQueries?.join(" / ") || searchResult.queries?.join(" / ") || cand.name} via npx skills find @ ${new Date().toISOString()}`;
      searchOutputStr = searchResult.results || "No matching skills found in registry.";
    }

    const systemInstruction = `
You are an expert AI software architect deciding whether to BUILD, REUSE, or EXTEND a skill based on community search results.
Prioritize REUSE to avoid skill sprawl.
Return your decision in JSON format ONLY. Do not write any conversational text.
`;

    const prompt = `
=== Candidate Skill ===
Name: ${cand.name}
Description: ${cand.description}
Evidence: ${cand.evidence}
Skeptic objection: ${cand.objection}

=== Ecosystem Search Output ===
${searchOutputStr}

=== Task ===
Determine the final decision:
- REUSE: if a public skill covers this codebase's need (record the exact source package name, e.g., 'user/repo@version').
- EXTEND: if a public skill covers the base, but a thin repo-specific overlay is required.
- BUILD: if genuinely unique tribal knowledge with no public equivalent.
- REJECT: if not worth building/reusing.

Return a JSON object with this exact shape:
{
  "finalDecision": "BUILD",
  "source": "this repo",
  "justification": "Why this decision was made in light of the search results"
}
`;

    let parsed;
    try {
      parsed = await llmCallJson(llmConfig, prompt, systemInstruction, "fast", `Dedupe(${cand.name})`);
    } catch (err) {
      // A malformed decision response must not build unchecked — defer.
      log.warn(`${err.message} — deferring "${cand.name}".`);
      finalCandidates.push({
        ...cand,
        decision: "DEFER",
        revisitWhen: "re-run — dedupe decision response was unparseable",
        source: "n/a",
        justification: "Dedupe decision could not be parsed",
        reuseCheckStatus,
      });
      continue;
    }

    let finalDecision = String(parsed.finalDecision || "").toUpperCase();
    let source = parsed.source;
    let justification = parsed.justification;
    let revisitWhen = cand.revisitWhen;

    // Validate the decision token; an unrecognized string (case drift, typo)
    // otherwise vanishes silently at authoring. Fail toward caution.
    if (!VALID_DECISIONS.has(finalDecision)) {
      log.warn(`Dedupe returned unrecognized decision "${parsed.finalDecision}" for "${cand.name}" — deferring.`);
      finalDecision = "DEFER";
      revisitWhen = revisitWhen || "re-run — dedupe returned an invalid decision";
    }

    // Monotonic: the dedupe step may CONFIRM or DOWNGRADE the Gate A verdict,
    // never upgrade a skeptic-demoted candidate to a build-like decision. Both
    // BUILD and EXTEND author an artifact and consume a build-cap slot, so a
    // cheaper model proposing EXTEND for a REUSE-ruled candidate also bypasses
    // "only survivors proceed". Rank: BUILD=2 > EXTEND=1 > everything else=0.
    const rank = (d) => (d === "BUILD" ? 2 : d === "EXTEND" ? 1 : 0);
    if (rank(finalDecision) > rank(cand.decision)) {
      log.warn(`Dedupe tried to upgrade "${cand.name}" (${cand.decision} → ${finalDecision}) — refused; the Gate A verdict stands.`);
      justification = `Dedupe proposed ${finalDecision} but Gate A had ruled ${cand.decision}; skeptic verdict stands. ${justification || ""}`.trim();
      finalDecision = cand.decision;
    }

    if (searchResult.status === "offline" && finalDecision === "BUILD") {
      log.substep(`Offline Mode: Allowed local build of "${cand.name}" (marked reuse-unchecked)`);
    } else if (searchResult.status === "offline" && (finalDecision === "REUSE" || finalDecision === "EXTEND")) {
      // Offline, the model can only guess a source from memory — the report
      // must never print an unverified `npx skills add <guess>`. Defer instead.
      log.substep(`Offline Mode: "${cand.name}" looked like ${finalDecision} of "${source}", but the source is unverified — deferring`);
      justification = `Proposed ${finalDecision} of "${source}" while offline — source unverified, re-check online`;
      finalDecision = "DEFER";
      source = "n/a (offline — reuse source unverified)";
      revisitWhen = "re-run online to verify the proposed reuse source";
    }

    // The source becomes a copy-paste `npx skills add <source>` in the report.
    // It is raw LLM output over untrusted repo content — reject anything that
    // is not a clean package reference so an injected payload can't ride into
    // a runnable command.
    if ((finalDecision === "REUSE" || finalDecision === "EXTEND") && !isSafePackageRef(source)) {
      log.warn(`Reuse source "${source}" for "${cand.name}" is not a valid package reference — deferring rather than emitting an unsafe install command.`);
      justification = `Proposed ${finalDecision} of "${source}", but the source failed package-reference validation`;
      finalDecision = "DEFER";
      source = "n/a (reuse source failed validation)";
      revisitWhen = revisitWhen || "re-run — proposed reuse source was not a valid package reference";
    }

    log.substep(`Final decision: ${finalDecision} (${source})`);

    finalCandidates.push({
      ...cand,
      decision: finalDecision,
      source,
      justification,
      revisitWhen,
      reuseCheckStatus,
    });
  }

  return finalCandidates;
}

// ----------------------------------------------------
// Phase 5: Author (Write SKILL.md files)
// ----------------------------------------------------
export async function runAuthorPhase(llmConfig, finalCandidates, survey) {
  log.phase("5", "Author (Write the skills)");

  const skillTemplate = await readPackageFile("skill-mining/references/templates/skill-template.md");
  const authoredSkills = [];

  for (const cand of finalCandidates) {
    if (cand.type !== "skill" || (cand.decision !== "BUILD" && cand.decision !== "EXTEND")) {
      continue;
    }

    log.step(`Authoring SKILL.md for "${cand.name}"...`);

    const systemInstruction = `
You are an expert technical writer and AI engineer authoring a highly specific SKILL.md file for a codebase.
Follow the Skill Template strictly. Use real commands, paths, and patterns from the Codebase Survey.
Do NOT write generic advice. The skill must be immediately executable by an agent.
Do NOT reference files under references/ — this skill ships as a single SKILL.md.
Return the raw markdown content ONLY. Do not wrap in markdown quotes or conversational text.
`;

    const prompt = `
=== Skill Template ===
${skillTemplate}

=== Candidate Skill Details ===
Name: ${cand.name} (the frontmatter name MUST be exactly this)
Description: ${cand.description}
Evidence: ${cand.evidence}
Representative Example: ${cand.example}
Decision: ${cand.decision} (Source: ${cand.source})
Justification: ${cand.justification}

=== Codebase Survey ===
Files available: ${survey.filesCount}
Directory shape:
${survey.treeSummary || "(unavailable)"}
Key configs: ${JSON.stringify(survey.configs, null, 2)}
Git hotspots: ${JSON.stringify(survey.git.hotspots, null, 2)}
Relevant source samples:
${Object.entries(survey.sourceSamples || {}).slice(0, 6).map(([p, text]) => `--- ${p} ---\n${text.slice(0, 1500)}`).join("\n\n")}

=== Task ===
Write the SKILL.md file. Use the exact templated frontmatter, filling in name, description, license, user-invocable, metadata.
Make sure to fill in:
1. Title and description (trigger-rich, starting with "Use when...")
2. When to use list
3. Specific procedure steps (with real paths and real commands from the survey)
4. Specific rules/conventions
5. A clear, actionable Verification section (e.g. command to run or file state to check).

Write the complete markdown text.
`;

    const markdown = await llmCall(llmConfig, prompt, systemInstruction, false, "strong");

    authoredSkills.push({
      name: cand.name,
      decision: cand.decision,
      source: cand.source,
      justification: cand.justification,
      reuseCheckStatus: cand.reuseCheckStatus,
      rawMarkdown: markdown.trim(),
    });

    log.substep(`Authored skill structure for "${cand.name}"`);
  }

  return authoredSkills;
}

// ----------------------------------------------------
// Phase 6: Compose (Agents & Team Manifest)
// ----------------------------------------------------
export async function runComposePhase(llmConfig, verifiedSkills, finalCandidates, options = {}) {
  log.phase("6", "Compose (Mine the agents)");

  const agentTemplate = await readPackageFile("skill-mining/references/templates/agent-template.md");
  const composedAgents = [];

  const agentCands = finalCandidates.filter(c => c.type === "agent" && c.decision !== "REJECT" && c.decision !== "DEFER");
  log.step(`Found ${agentCands.length} agent roles to compose`);

  const skillSummaries = verifiedSkills.map(s => ({
    name: s.name,
    description: s.rawMarkdown.split("\n").slice(0, 10).join("\n"),
  }));

  for (const agent of agentCands) {
    log.step(`Composing agent role: "${agent.name}"...`);

    const systemInstruction = `
You are an expert AI software architect composing agent role definitions (personas) that load and use mined skills.
Follow the Agent Template strictly. The frontmatter name MUST be exactly the agent's given name.
Only reference skills from the provided list — never invent skill names.
Return the raw markdown content ONLY. Do not wrap in markdown quotes or conversational text.
`;

    const prompt = `
=== Agent Template ===
${agentTemplate}

=== Agent Role Details ===
Name: ${agent.name}
Description: ${agent.description}

=== Mined Skills Available ===
${JSON.stringify(skillSummaries, null, 2)}

=== Task ===
Write the agent definition markdown file. Fill in the frontmatter: name, description, loads_skills (select relevant ones from the list), capabilities.
Fill in:
1. Mandate / introduction.
2. Skills to load (briefly summarizing what each skill gives this agent).
3. Detailed operating procedure steps (incorporating the skills).
${options.noTeam ? "" : "4. Team handoffs (triggers, inputs, outputs, handoffs)."}
5. Boundaries.

Also return nothing but the markdown text.
`;

    const markdown = await llmCall(llmConfig, prompt, systemInstruction, false, "strong");
    const raw = markdown.trim();

    // Extract loads_skills from the authored definition (best effort) so the
    // report reflects what it actually claims to load. Word-boundary match —
    // a bare substring test would let "test" false-positive inside "test-runner".
    const skillNames = verifiedSkills.map(s => s.name);
    const loadedSkills = skillNames.filter(n => {
      const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^\\w-])${escaped}($|[^\\w-])`).test(raw);
    });

    composedAgents.push({
      name: agent.name,
      description: agent.description,
      loadedSkills,
      rawMarkdown: raw,
    });

    log.substep(`Composed agent: "${agent.name}" (loads: ${loadedSkills.join(", ") || "none detected"})`);
  }

  return { agents: composedAgents };
}

/**
 * Compose the team manifest from the agents that SURVIVED the cold-load gate
 * and lint — composing it earlier (inside runComposePhase) baked dropped
 * agents into the handoff loop, advertising personas with no written file.
 */
export async function composeTeamManifest(llmConfig, survivingAgents, verifiedSkills) {
  if (survivingAgents.length === 0) {
    return "";
  }

  log.step("Composing team manifest workflow (from gate-surviving agents)...");
  const manifestPrompt = `
Given these composed agents (the ONLY agents that exist — do not reference any other persona):
${JSON.stringify(survivingAgents.map(a => ({ name: a.name, description: a.description, loadedSkills: a.loadedSkills })), null, 2)}

And these verified skills:
${JSON.stringify(verifiedSkills.map(s => ({ name: s.name })), null, 2)}

Create a markdown table for the Team Manifest.
It must list: Persona, Loads skills, Triggered by, Receives, Produces, Hands off to (payload — proceed-when), Escalates when.
Every handoff target must be one of the listed agents (or "human").
Also include the "Handoff loop" description (e.g. Implementer -> Reviewer -> Fixer -> Reviewer).
Return the markdown table and loop description ONLY. Do not write other text.
`;

  const manifestResult = await llmCall(llmConfig, manifestPrompt, "Return only the markdown team manifest section.", false, "fast");
  log.substep("Team manifest workflow established");
  return manifestResult.trim();
}

// ----------------------------------------------------
// Legacy fallback: parse an existing markdown report with an LLM.
// Only used when SKILLS_MINED.json (the structured sidecar) is absent.
// ----------------------------------------------------
export async function parseMinedReport(llmConfig, reportContent) {
  log.step("No SKILLS_MINED.json sidecar found — falling back to LLM parse of SKILLS_MINED.md...");

  const systemInstruction = `
You are a precise data extraction specialist. Extract skill details from the report.
Return your findings in JSON format ONLY. Do not write any conversational text.
`;

  const prompt = `
=== SKILLS_MINED.md ===
${reportContent}

=== Task ===
Extract all entries from the "Built / reused skills — with identity" table.
For each skill, extract:
- name: name of the skill
- origin: BUILT, EXTEND, or REUSED
- path: relative path to the skill (e.g. .agents/skills/name/)
- source: source or version pin
- fingerprint: content fingerprint (e.g. sha256:...)
- verification: verification details
- reuseCheckStatus: the reuse-checked / reuse-unchecked status

Return a JSON object with this exact shape:
{
  "skills": [
    {
      "name": "name-of-skill",
      "origin": "BUILT",
      "path": ".agents/skills/name-of-skill/",
      "source": "...",
      "fingerprint": "sha256:...",
      "verification": "...",
      "reuseCheckStatus": "..."
    }
  ]
}
`;

  const response = await llmCall(llmConfig, prompt, systemInstruction, true, "fast");
  const parsed = JSON.parse(cleanJsonResponse(response));
  log.step(`Extracted ${parsed.skills.length} skills from report`);
  return parsed.skills;
}
