import { log, VALID_DECISIONS } from "./utils.js";
import { llmCall, llmCallJson, cleanJsonResponse } from "./llm.js";
import { readPackageFile } from "./phases.js";

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

  const systemInstruction = `
You are the independent skeptic for Gate A. You are seeing these candidates for
the first time — you have NOT seen the proposer's scores and must derive your own.
Default position: candidates should be REUSED, DEFERRED, or REJECTED, not built.
Attack recurrence (is the evidence real? note evidenceVerified=false means cited
paths do NOT exist in the repo), bespokeness (the ecosystemSearch field contains
REAL registry search output — use it, do not guess from memory), leverage (would
a competent agent get this right anyway?), and stability.
Return your findings in JSON format ONLY. Do not write any conversational text.
`;

  const prompt = `
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

  log.step(`Independent skeptic blind re-scoring ${toChallenge.length} BUILD/EXTEND candidate(s)...`);
  let parsed;
  try {
    parsed = await llmCallJson(llmConfig, prompt, systemInstruction, "gate", "Gate A");
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

  for (const c of challenged) {
    const deltaNote = c.gateADelta != null ? ` (score delta vs proposer: ${c.gateADelta})` : "";
    log.substep(`${c.name}: ${c.decision}${deltaNote}`);
  }
  log.step("Gate A challenges processed");

  return [...challenged, ...passThrough];
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
function buildGroundTruth(survey) {
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

async function reviewSkillOnce(llmConfig, adversarialReview, markdown, testTask, groundTruth) {
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
export async function runGateB(llmConfig, authoredSkills, survey) {
  log.gate("B", "Red-team the artifact (grounded)");

  const adversarialReview = await readPackageFile("skill-mining/references/adversarial-review.md");
  const groundTruth = buildGroundTruth(survey);
  const verifiedSkills = [];
  const rejectedSkills = [];
  const dateStr = new Date().toISOString().split("T")[0];

  for (const skill of authoredSkills) {
    log.step(`Red-teaming skill: "${skill.name}"...`);

    const { task: testTask, origin: taskOrigin } = await pickTestTask(llmConfig, skill, survey);
    log.substep(`Test task (${taskOrigin}): "${testTask}"`);

    let markdown = skill.rawMarkdown;
    let verdict = null;
    let allObjections = [];
    let fixRounds = 0;

    for (let round = 0; round <= MAX_FIX_ROUNDS; round++) {
      let review;
      try {
        review = await reviewSkillOnce(llmConfig, adversarialReview, markdown, testTask, groundTruth);
      } catch (err) {
        // An unparseable red-team verdict must not abort the run (discarding
        // every other verified skill) — fail this one skill closed.
        log.warn(`${err.message} — treating "${skill.name}" as not verified (REJECT).`);
        verdict = "REJECT";
        break;
      }
      verdict = review.verdict;
      log.substep(`Gate B round ${round + 1} verdict: ${verdict}`);

      if (verdict === "SHIP" || verdict === "REJECT") break;

      // FIX: apply edits, then loop back for re-verification
      allObjections = allObjections.concat(review.objections || []);
      fixRounds++;
      log.step(`Applying Gate B corrections for "${skill.name}" (round ${fixRounds})...`);
      const fixPrompt = `
=== Original SKILL.md ===
${markdown}

=== Requested Edits ===
${review.requestedEdits || "(none specified)"}
Objections raised:
${(review.objections || []).join("\n")}

=== Task ===
Apply these fixes directly into the SKILL.md text. Ensure it remains specific and
follows all template guidelines. Return the updated SKILL.md raw markdown content
ONLY. Do not write conversational text.
`;
      const fixedMarkdown = await llmCall(llmConfig, fixPrompt, "Return only the updated markdown content.", false, "strong");
      markdown = fixedMarkdown.trim();
    }

    if (verdict !== "SHIP") {
      const reason = verdict === "REJECT"
        ? "rejected by Gate B skeptic"
        : `did not reach SHIP within ${MAX_FIX_ROUNDS} fix round(s)`;
      log.warn(`Skill "${skill.name}" ${reason}. Excluded (fail closed).`);
      rejectedSkills.push({
        ...skill,
        gateBOutcome: `Gate B @ ${dateStr}: used cold vs "${testTask}" → REJECTED (${reason})`,
      });
      continue;
    }

    const fixNote = fixRounds > 0
      ? `; fixes applied (${fixRounds} round(s)): ${allObjections.slice(0, 3).join("; ")}`
      : "; fixes: none";
    verifiedSkills.push({
      ...skill,
      rawMarkdown: markdown,
      verification: `**Gate B** @ ${dateStr}: used cold vs "${testTask}" (${taskOrigin}) → SHIP${fixNote}`,
      testTask,
    });
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
export async function runAgentGate(llmConfig, composedAgents) {
  if (composedAgents.length === 0) return { verifiedAgents: [], rejectedAgents: [] };

  log.gate("B′", "Cold-load check on composed agents");
  const verifiedAgents = [];
  const rejectedAgents = [];
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

  for (const agent of composedAgents) {
    log.step(`Cold-loading agent definition: "${agent.name}"...`);

    let markdown = agent.rawMarkdown;
    let review;
    try {
      review = await llmCallJson(llmConfig, buildPrompt(markdown), systemInstruction, "gate", `Agent gate(${agent.name})`);
      log.substep(`Verdict: ${review.verdict}`);

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
        log.substep(`Re-check verdict: ${review.verdict}`);
      }
    } catch (err) {
      // Unparseable gate verdict — drop just this agent, keep the rest.
      log.warn(`${err.message} — dropping agent "${agent.name}".`);
      rejectedAgents.push(agent);
      continue;
    }

    if (review.verdict === "SHIP") {
      verifiedAgents.push({
        ...agent,
        rawMarkdown: markdown,
        verification: `**Agent gate** @ ${dateStr}: cold-load → SHIP`,
      });
    } else {
      log.warn(`Agent "${agent.name}" did not pass the cold-load check. Dropped.`);
      rejectedAgents.push(agent);
    }
  }

  return { verifiedAgents, rejectedAgents };
}
