import { log, VALID_DECISIONS, mapLimit } from "./utils.js";
import { llmCall, llmCallJson, cleanJsonResponse } from "./llm.js";
import { readPackageFile } from "./phases.js";
import { groundSkillArtifact } from "./grounding.js";

const MAX_FIX_ROUNDS = 2;

// Sum of absolute per-axis differences between proposer and skeptic scores —
// a large delta is signal (recorded in the report), not something to average away.
export function scoreDelta(proposerScores = {}, skepticScores = {}) {
  const axes = ["freq", "lev", "bsp", "stab", "ver"];
  return axes.reduce((sum, axis) => {
    const a = Number(proposerScores[axis]) || 0;
    const b = Number(skepticScores[axis]) || 0;
    return sum + Math.abs(a - b);
  }, 0);
}

// ----------------------------------------------------
// Gate A: Challenge the decision (blind re-score)
// ----------------------------------------------------

// Mistakes in safety-, security-, or money-relevant skills are the expensive
// ones — those candidates get a 3-skeptic panel instead of a single verdict.
// Deterministic keyword test so risk routing itself needs no LLM. Word-anchored
// so prose lookalikes ("author", "reproduce", "tokenizer", "product") don't
// route plainly non-risk candidates into the 3-skeptic panel.
const RISK_RE = /\b(?:secur|o?auth(?!or(?:\b|s\b|ing|ed|ship))|secret|token(?!i[sz])|credential|deploy|release|publish|payment|billing|money|migrat|prod\b|production|infra)/i;

export function isRiskRelevant(candidate) {
  const evidence = typeof candidate.evidence === "string"
    ? candidate.evidence
    : JSON.stringify(candidate.evidence || "");
  return RISK_RE.test(`${candidate.name || ""} ${candidate.description || ""} ${evidence}`);
}

const GATE_A_SYSTEM = `
You are the independent skeptic for Gate A. You are seeing these candidates for
the first time — you have NOT seen the proposer's scores and must derive your own.
Default position: candidates should be REUSED, DEFERRED, or REJECTED, not built.
Attack recurrence (is the evidence real? note evidenceVerified=false means cited
paths do NOT exist in the repo), bespokeness (the ecosystemSearch field contains
REAL registry search output — use it, do not guess from memory), leverage (would
a competent agent get this right anyway?), and stability.
Return your findings in JSON format ONLY. Do not write any conversational text.
`;

// One prompt builder for both the batch skeptic and the per-candidate panel
// calls — every skeptic sees the identical blind payload shape.
function buildSkepticPrompt(adversarialReview, blindCandidates) {
  return `
=== Adversarial Review Guidelines (Gate A) ===
${adversarialReview}

=== Candidates (blind — no proposer scores included) ===
${JSON.stringify(blindCandidates, null, 2)}

=== Task ===
For EACH candidate, independently:
1. Score the five axes 1–5: freq, lev, bsp, stab, ver. A candidate with
   evidenceVerified=false cannot justify freq above 2 — unproven recurrence.
2. If the ecosystemSearch output shows a plausibly matching maintained skill,
   the verdict is REUSE or EXTEND — name it in the objection.
3. Verdict: one of BUILD | EXTEND | REUSE | REJECT | DEFER. BUILD only if you
   could not refute it. DEFER if promising but the evidence is too thin today —
   include a "revisitWhen" condition.
4. Record the single strongest objection (or "survived: <reason>").

Return a JSON object with this exact shape:
{
  "challengedCandidates": [
    {
      "name": "kebab-case-name",
      "scores": { "freq": 1, "lev": 1, "bsp": 1, "stab": 1, "ver": 1 },
      "verdict": "REUSE",
      "objection": "…",
      "revisitWhen": "only if verdict is DEFER"
    }
  ]
}
Include every candidate from the list, by exact name.
`;
}

const isBuildLike = (verdict) => verdict === "BUILD" || verdict === "EXTEND";

/**
 * 3-skeptic panel for a risk-relevant candidate that survived the batch
 * skeptic: two ADDITIONAL independent verdicts on the same blind payload.
 * Any REJECT vetoes; build-like stands only with a 2-of-3 majority; anything
 * else defers. A failed extra skeptic votes DEFER — caution, never a free pass.
 */
async function escalateRiskCandidate(llmConfig, adversarialReview, cand, blind) {
  const votes = [{ verdict: cand.decision, objection: cand.objection || "n/a" }];

  // The two extra skeptics are independent by construction (same blind
  // payload, no shared state), so they run concurrently. Promise.all keeps
  // the vote order stable: batch skeptic, then skeptic 2, then skeptic 3.
  const extraVotes = await Promise.all([0, 1].map(async (i) => {
    const label = `Gate A skeptic ${i + 2} (${cand.name})`;
    try {
      const parsed = await llmCallJson(
        llmConfig, buildSkepticPrompt(adversarialReview, [blind]), GATE_A_SYSTEM, "gate", label
      );
      const v = (parsed.challengedCandidates || []).find(x => x.name === cand.name)
        || (parsed.challengedCandidates || [])[0];
      const verdict = v && VALID_DECISIONS.has(v.verdict) ? v.verdict : "DEFER";
      return { verdict, objection: v?.objection || "n/a" };
    } catch (err) {
      return { verdict: "DEFER", objection: `${label}: unparseable — counted as DEFER` };
    }
  }));
  votes.push(...extraVotes);

  const verdicts = votes.map(v => v.verdict);
  if (verdicts.includes("REJECT")) {
    const veto = votes.find(v => v.verdict === "REJECT");
    return {
      ...cand,
      gateAVotes: votes,
      decision: "REJECT",
      objection: `Gate A multi-skeptic veto (${verdicts.join("/")}): ${veto.objection}`,
    };
  }
  if (verdicts.filter(isBuildLike).length >= 2) {
    return { ...cand, gateAVotes: votes };
  }
  return {
    ...cand,
    gateAVotes: votes,
    decision: "DEFER",
    objection: `Gate A multi-skeptic split (${verdicts.join("/")}) — no build majority among 3 skeptics`,
    revisitWhen: cand.revisitWhen || "next mining pass",
  };
}

/**
 * The skeptic NEVER sees the proposer's scores or decisions — anchored
 * "review" rubber-stamps. It re-scores from raw evidence plus real ecosystem
 * search results, with the burden of proof on BUILD. The skeptic's verdict
 * stands; the proposer-vs-skeptic delta is recorded as signal.
 */
export async function runGateA(llmConfig, scoredCandidates, searchResults = {}) {
  log.gate("A", "Challenge the decision (blind re-score)");

  const adversarialReview = await readPackageFile("skill-mining/references/adversarial-review.md");

  // Agents are excluded: the skeptic's attacks (recurrence, registry reuse,
  // bespokeness) are skill-shaped — judging a role by them silently demotes
  // legitimate agents. Agents get their own cold-load gate after Compose.
  const isChallengeable = (c) =>
    c.type !== "agent" && (c.decision === "BUILD" || c.decision === "EXTEND");
  const toChallenge = scoredCandidates.filter(isChallengeable);
  const passThrough = scoredCandidates.filter(c => !isChallengeable(c));

  if (toChallenge.length === 0) {
    log.step("No BUILD/EXTEND candidates to challenge");
    return scoredCandidates;
  }

  // Blind payload: name/description/evidence only — no proposer scores, no decisions.
  const blindCandidates = toChallenge.map(c => ({
    name: c.name,
    type: c.type,
    description: c.description,
    evidence: c.evidence,
    example: c.example,
    evidenceVerified: c.evidenceVerified !== false,
    evidenceNotes: c.evidenceNotes || "n/a",
    ecosystemSearch: (searchResults[c.name]?.results || "").slice(0, 2000) || "(no search results available)",
  }));

  const prompt = buildSkepticPrompt(adversarialReview, blindCandidates);

  log.step(`Independent skeptic blind re-scoring ${toChallenge.length} BUILD/EXTEND candidate(s)...`);
  let parsed;
  try {
    parsed = await llmCallJson(llmConfig, prompt, GATE_A_SYSTEM, "gate", "Gate A");
  } catch (err) {
    // The skeptic couldn't be parsed — never wave the candidates through
    // unchallenged. Defer them all; the next pass re-challenges.
    log.warn(`${err.message} — deferring all challenged candidates (skeptic unavailable).`);
    const deferred = toChallenge.map(c => ({
      ...c,
      decision: "DEFER",
      objection: "Gate A skeptic response unparseable — re-challenge next pass",
      revisitWhen: "next mining pass",
      gateADelta: null,
    }));
    return [...deferred, ...passThrough];
  }
  const verdictsByName = new Map(
    (parsed.challengedCandidates || []).map(v => [v.name, v])
  );

  const challenged = toChallenge.map(cand => {
    const verdict = verdictsByName.get(cand.name);
    if (!verdict) {
      // Skeptic dropped it — fail toward caution, not toward building
      log.warn(`Gate A: skeptic returned no verdict for "${cand.name}" — deferring it`);
      return {
        ...cand,
        decision: "DEFER",
        objection: "Gate A: no skeptic verdict returned — re-challenge on next pass",
        revisitWhen: "next mining pass",
        gateADelta: null,
      };
    }
    const decision = VALID_DECISIONS.has(verdict.verdict) ? verdict.verdict : "DEFER";
    return {
      ...cand,
      scores: verdict.scores || cand.scores,
      decision,
      objection: verdict.objection || "n/a",
      revisitWhen: decision === "DEFER" ? (verdict.revisitWhen || "next mining pass") : cand.revisitWhen,
      gateADelta: scoreDelta(cand.scores, verdict.scores),
    };
  });

  // Multi-skeptic escalation: a risk-relevant candidate still standing at
  // BUILD/EXTEND after one skeptic needs two more independent verdicts.
  const blindByName = new Map(blindCandidates.map(b => [b.name, b]));
  const escalated = [];
  for (const cand of challenged) {
    if (!isBuildLike(cand.decision) || !isRiskRelevant(cand)) {
      escalated.push(cand);
      continue;
    }
    log.step(`Risk-relevant "${cand.name}" survived the first skeptic — convening 3-skeptic panel...`);
    escalated.push(await escalateRiskCandidate(llmConfig, adversarialReview, cand, blindByName.get(cand.name)));
  }

  for (const c of escalated) {
    const deltaNote = c.gateADelta != null ? ` (score delta vs proposer: ${c.gateADelta})` : "";
    const voteNote = c.gateAVotes ? ` [votes: ${c.gateAVotes.map(v => v.verdict).join("/")}]` : "";
    log.substep(`${c.name}: ${c.decision}${deltaNote}${voteNote}`);
  }
  log.step("Gate A challenges processed");

  return [...escalated, ...passThrough];
}

// ----------------------------------------------------
// Gate B: Red-team the artifact (grounded, with re-verification loop)
// ----------------------------------------------------

// Pick a real recent task from git history instead of deriving one from the
// skill text (which is circular — the skill always "covers" a task invented from it).
async function pickTestTask(llmConfig, skill, survey) {
  const recentCommits = (survey?.git?.recentCommits || []).slice(0, 30).join("\n");
  if (!recentCommits) {
    const fallback = await llmCall(
      llmConfig,
      `Given this skill, devise a realistic concrete test task an agent would execute in this codebase:\n${skill.rawMarkdown.substring(0, 1200)}\nReturn one sentence only.`,
      "Return a 1-sentence task description only.",
      false,
      "fast"
    );
    return { task: fallback.trim(), origin: "synthetic (no git history available)" };
  }

  const response = await llmCall(
    llmConfig,
    `
=== Recent real commits in this repo ===
${recentCommits}

=== Skill under test ===
Name: ${skill.name}
First lines:
${skill.rawMarkdown.substring(0, 1200)}

=== Task ===
Pick ONE recent commit whose change an agent could plausibly redo USING this
skill, and phrase it as a concrete task. Return JSON only:
{ "task": "one-sentence task", "commit": "the chosen commit hash or 'none'" }
If no commit is relevant, set commit to "none" and devise a realistic task instead.
`,
    "Return JSON only.",
    true,
    "fast"
  );
  try {
    const parsed = JSON.parse(cleanJsonResponse(response));
    const origin = parsed.commit && parsed.commit !== "none"
      ? `real commit ${parsed.commit}`
      : "synthetic (no relevant recent commit)";
    return { task: (parsed.task || "").trim(), origin };
  } catch (err) {
    return { task: response.trim(), origin: "synthetic (unparsed)" };
  }
}

// Compact ground truth so the reviewer can fact-check paths/commands instead
// of judging internal coherence only.
export function buildGroundTruth(survey) {
  if (!survey) return "(no repo ground truth available)";
  const pkg = survey.configs?.["package.json"] || "";
  return [
    "Repo directory shape:",
    survey.treeSummary || "(unknown)",
    "",
    "File extensions:",
    survey.extHistogram || "(unknown)",
    "",
    pkg ? `package.json (truncated):\n${pkg.slice(0, 1500)}` : "(no package.json)",
  ].join("\n");
}

// Deterministic grounding findings arrive pre-verified by code — the reviewer
// must treat them as defects, not opinions it may overrule.
function renderGroundingFindings(findings) {
  return [
    "=== Deterministic ground-truth defects (verified by code, must be treated as defects) ===",
    findings.length ? findings.map(f => `- ${f}`).join("\n") : "(none detected)",
  ].join("\n");
}

async function reviewSkillOnce(llmConfig, adversarialReview, markdown, testTask, groundTruth, groundingFindings) {
  const systemInstruction = `
You are the cold-loaded adversarial reviewer for Gate B. Your job is to find gaps
in the authored SKILL.md. Assume the skill is inadequate.
You have the SKILL.md, a real task, and REPO GROUND TRUTH (directory shape, real
package scripts). Use the ground truth ONLY to fact-check the skill's paths and
commands — a command or path that contradicts the ground truth is a defect.
Return your findings in JSON format ONLY. Do not write any conversational text.
`;

  const prompt = `
=== Adversarial Review Guidelines (Gate B) ===
${adversarialReview}

=== Authored SKILL.md ===
${markdown}

=== Test Task (from real repo history) ===
${testTask}

=== REPO GROUND TRUTH (for fact-checking only) ===
${groundTruth}

${renderGroundingFindings(groundingFindings)}

=== Task ===
Walk the test task using ONLY the instructions in the SKILL.md. Identify:
1. Ambiguous steps; commands/paths that contradict the ground truth.
2. Missing details (assumed knowledge a cold agent would not have).
3. Whether the Verification section actually proves success.
4. Verdict: SHIP (usable as-is), FIX (needs the specific edits you list), or
   REJECT (not meaningful / generic advice).

Return a JSON object with this exact shape:
{
  "verdict": "SHIP",
  "objections": ["…"],
  "requestedEdits": "Exact section/line edits if verdict is FIX"
}
`;

  return llmCallJson(llmConfig, prompt, systemInstruction, "gate", "Gate B review");
}

/**
 * Gate B with a closed FIX loop: FIX verdicts are applied and the FIXED
 * artifact is re-red-teamed. Only SHIP is terminal-verified; a skill that
 * cannot reach SHIP within MAX_FIX_ROUNDS is rejected (fail closed), never
 * shipped with "FIX" recorded as its verification.
 */
// Bounds concurrent red-team pipelines. Each skill's internal review→fix loop
// stays strictly sequential — only whole skills overlap.
const GATE_B_CONCURRENCY = 2;

export async function runGateB(llmConfig, authoredSkills, survey) {
  log.gate("B", "Red-team the artifact (grounded)");

  const adversarialReview = await readPackageFile("skill-mining/references/adversarial-review.md");
  const groundTruth = buildGroundTruth(survey);
  const dateStr = new Date().toISOString().split("T")[0];

  // One outcome per skill: { verified } or { rejected }. Log lines from
  // concurrent skills interleave, so substeps carry the skill name.
  const redTeamOne = async (skill) => {
    log.step(`Red-teaming skill: "${skill.name}"...`);

    // Same per-skill fail-closed contract as the review and fix calls below:
    // a failed task-pick (e.g. LLM retry exhaustion) must not abort the run
    // (discarding every other verified skill) — fail this one skill closed.
    let testTask;
    let taskOrigin;
    try {
      ({ task: testTask, origin: taskOrigin } = await pickTestTask(llmConfig, skill, survey));
    } catch (err) {
      log.warn(`${err.message} — test-task selection failed; treating "${skill.name}" as not verified (REJECT).`);
      return {
        rejected: {
          ...skill,
          gateBOutcome: `Gate B @ ${dateStr}: test-task selection failed → REJECTED (fail closed)`,
        },
      };
    }
    log.substep(`"${skill.name}" test task (${taskOrigin}): "${testTask}"`);

    let markdown = skill.rawMarkdown;
    let verdict = null;
    let allObjections = [];
    let fixRounds = 0;

    for (let round = 0; round <= MAX_FIX_ROUNDS; round++) {
      // Re-ground every round: fixes change the cited paths/commands, and the
      // reviewer must see the CURRENT artifact's deterministic defects (C7).
      const groundingFindings = groundSkillArtifact(markdown, survey);
      let review;
      try {
        review = await reviewSkillOnce(llmConfig, adversarialReview, markdown, testTask, groundTruth, groundingFindings);
      } catch (err) {
        // An unparseable red-team verdict must not abort the run (discarding
        // every other verified skill) — fail this one skill closed.
        log.warn(`${err.message} — treating "${skill.name}" as not verified (REJECT).`);
        verdict = "REJECT";
        break;
      }
      verdict = review.verdict;

      // llmCallJson only parses — it does not validate the schema, so a
      // reviewer may return objections as a string (or any non-array).
      // Normalize it HERE, before the grounding merge and fix prompt below
      // use it outside the per-skill try blocks: a `.join`/spread TypeError
      // there would escape containment, reject mapLimit, and abort the whole
      // run — discarding every other skill's work.
      review = {
        ...review,
        objections: Array.isArray(review.objections)
          ? review.objections
          : review.objections == null || review.objections === ""
            ? []
            : [String(review.objections)],
      };

      // Grounding findings are code-verified ground truth — a reviewer SHIP
      // cannot overrule them (prompt-only enforcement is exactly the
      // rubber-stamp this gate exists to catch). Downgrade to FIX so the
      // defects are repaired, or fail closed when the rounds run out.
      if (verdict === "SHIP" && groundingFindings.length > 0) {
        log.warn(`Gate B round ${round + 1} ("${skill.name}"): reviewer said SHIP but ${groundingFindings.length} code-verified grounding defect(s) remain — downgrading to FIX`);
        verdict = "FIX";
        review = {
          ...review,
          verdict: "FIX",
          objections: [...(review.objections || []), ...groundingFindings],
          requestedEdits: review.requestedEdits
            || "Correct the deterministic ground-truth defects listed above so every cited path and command exists in the repo.",
        };
      }
      log.substep(`Gate B round ${round + 1} verdict for "${skill.name}": ${verdict}`);

      if (verdict === "SHIP" || verdict === "REJECT") break;

      // A FIX verdict on the final round cannot be re-reviewed — applying it
      // would spend a strong-model call on output that is discarded below.
      if (round === MAX_FIX_ROUNDS) break;

      // FIX: apply edits, then loop back for re-verification
      allObjections = allObjections.concat(review.objections || []);
      fixRounds++;
      log.step(`Applying Gate B corrections for "${skill.name}" (round ${fixRounds})...`);
      // The repairer gets the same facts the reviewer had — test task, repo
      // ground truth, deterministic findings — so path/command defects get
      // fixed against reality instead of guessed at.
      const fixPrompt = `
=== Original SKILL.md ===
${markdown}

=== Test Task the skill must support ===
${testTask}

=== REPO GROUND TRUTH (paths and commands must match this) ===
${groundTruth}

${renderGroundingFindings(groundingFindings)}

=== Requested Edits ===
${review.requestedEdits || "(none specified)"}
Objections raised:
${(review.objections || []).join("\n")}

=== Task ===
Apply these fixes directly into the SKILL.md text. Every path and command in the
result must exist in the repo ground truth above. Ensure it remains specific and
follows all template guidelines. Return the updated SKILL.md raw markdown content
ONLY. Do not write conversational text.
`;
      // Same per-skill fail-closed contract as the review call above: a failed
      // fix application (e.g. output-budget truncation) must not abort the run
      // and discard every other verified skill — reject just this skill.
      let fixedMarkdown;
      try {
        fixedMarkdown = await llmCall(llmConfig, fixPrompt, "Return only the updated markdown content.", false, "strong");
      } catch (err) {
        log.warn(`${err.message} — fix application failed; treating "${skill.name}" as not verified (REJECT).`);
        verdict = "REJECT";
        break;
      }
      markdown = fixedMarkdown.trim();
    }

    if (verdict !== "SHIP") {
      const reason = verdict === "REJECT"
        ? "rejected by Gate B skeptic"
        : `did not reach SHIP within ${MAX_FIX_ROUNDS} fix round(s)`;
      log.warn(`Skill "${skill.name}" ${reason}. Excluded (fail closed).`);
      return {
        rejected: {
          ...skill,
          rawMarkdown: markdown,
          gateBVerdict: verdict,
          gateBOutcome: `Gate B @ ${dateStr}: used cold vs "${testTask}" → REJECTED (${reason})`,
        },
      };
    }

    const fixNote = fixRounds > 0
      ? `; fixes applied (${fixRounds} round(s)): ${allObjections.slice(0, 3).join("; ")}`
      : "; fixes: none";
    return {
      verified: {
        ...skill,
        rawMarkdown: markdown,
        verification: `**Gate B** @ ${dateStr}: used cold vs "${testTask}" (${taskOrigin}) → SHIP${fixNote}`,
        testTask,
      },
    };
  };

  // Collect one outcome per input slot, then partition in order — pushing
  // from concurrent tasks would make verifiedSkills/rejectedSkills order
  // depend on completion timing instead of the input skill order.
  const outcomes = await mapLimit(authoredSkills, GATE_B_CONCURRENCY, redTeamOne);
  const verifiedSkills = [];
  const rejectedSkills = [];
  for (const outcome of outcomes) {
    if (outcome.verified) verifiedSkills.push(outcome.verified);
    else rejectedSkills.push(outcome.rejected);
  }

  return { verifiedSkills, rejectedSkills };
}

// ----------------------------------------------------
// Agent gate: cold-load check on composed agent definitions
// ----------------------------------------------------
/**
 * Agents previously bypassed every gate. Same principle as Gate B: a fresh
 * reviewer gets ONLY the definition and judges whether the role is operable.
 * One fix round; non-SHIP agents are dropped.
 */
// Bounds concurrent agent cold-load reviews; each agent's review→fix→re-check
// chain stays sequential.
const AGENT_GATE_CONCURRENCY = 3;

export async function runAgentGate(llmConfig, composedAgents) {
  if (composedAgents.length === 0) return { verifiedAgents: [], rejectedAgents: [] };

  log.gate("B′", "Cold-load check on composed agents");
  const dateStr = new Date().toISOString().split("T")[0];

  const systemInstruction = `
You are a cold-loaded reviewer. You have ONLY this agent definition. Assume it is
inadequate. Could an agent operate this role from the definition alone — are its
triggers, loaded skills, procedure, handoffs, and boundaries unambiguous?
Return JSON only.
`;

  // Rebuild the prompt from the current markdown each time — string-replacing
  // the old definition out of the old prompt silently re-reviews stale content
  // whenever the fixed text doesn't match byte-for-byte.
  const buildPrompt = (markdown) => `
=== Agent definition ===
${markdown}

=== Task ===
Report every ambiguity, missing input/output, or skill reference that is vague.
Verdict: SHIP | FIX | REJECT.
Return: { "verdict": "SHIP", "objections": ["…"], "requestedEdits": "…" }
`;

  // One outcome per agent: { verified } or { rejected }. Log lines from
  // concurrent agents interleave, so substeps carry the agent name.
  const coldLoadOne = async (agent) => {
    log.step(`Cold-loading agent definition: "${agent.name}"...`);

    let markdown = agent.rawMarkdown;
    let review;
    try {
      review = await llmCallJson(llmConfig, buildPrompt(markdown), systemInstruction, "gate", `Agent gate(${agent.name})`);
      log.substep(`"${agent.name}" verdict: ${review.verdict}`);

      if (review.verdict === "FIX") {
        const fixed = await llmCall(
          llmConfig,
          `=== Agent definition ===\n${markdown}\n\n=== Requested edits ===\n${review.requestedEdits || ""}\n${(review.objections || []).join("\n")}\n\nApply the fixes. Return only the updated markdown.`,
          "Return only the updated markdown content.",
          false,
          "strong"
        );
        markdown = fixed.trim();
        review = await llmCallJson(llmConfig, buildPrompt(markdown), systemInstruction, "gate", `Agent gate(${agent.name}) re-check`);
        log.substep(`"${agent.name}" re-check verdict: ${review.verdict}`);
      }
    } catch (err) {
      // Unparseable gate verdict — drop just this agent, keep the rest.
      log.warn(`${err.message} — dropping agent "${agent.name}".`);
      return { rejected: agent };
    }

    if (review.verdict === "SHIP") {
      return {
        verified: {
          ...agent,
          rawMarkdown: markdown,
          verification: `**Agent gate** @ ${dateStr}: cold-load → SHIP`,
        },
      };
    }
    log.warn(`Agent "${agent.name}" did not pass the cold-load check. Dropped.`);
    return { rejected: agent };
  };

  // Same ordering rule as Gate B: collect per-slot outcomes, then partition
  // in input order — never push from concurrent tasks.
  const outcomes = await mapLimit(composedAgents, AGENT_GATE_CONCURRENCY, coldLoadOne);
  const verifiedAgents = [];
  const rejectedAgents = [];
  for (const outcome of outcomes) {
    if (outcome.verified) verifiedAgents.push(outcome.verified);
    else rejectedAgents.push(outcome.rejected);
  }

  return { verifiedAgents, rejectedAgents };
}
