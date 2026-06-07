import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./utils.js";
import { llmCall, cleanJsonResponse } from "./llm.js";
import { findEcosystemSkills } from "./dedupe.js";
import { generateSkillFingerprint } from "./fingerprint.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.join(__dirname, "..");

// Helper to read markdown guidelines/templates from the package itself
export async function readPackageFile(relPath) {
  const fullPath = path.join(packageRoot, relPath);
  return await fs.readFile(fullPath, "utf8");
}

// Ensure directory exists
async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

// ----------------------------------------------------
// Phase 1 & 2: Survey & Detect (+ Completeness Critic)
// ----------------------------------------------------
export async function runDetectPhase(llmConfig, survey) {
  log.phase("1 & 2", "Survey & Detect");
  
  const taxonomy = await readPackageFile("skill-mining/references/candidate-taxonomy.md");
  const skillMiningDoc = await readPackageFile("skill-mining/SKILL.md");

  const systemInstruction = `
You are an expert AI software architect performing Phase 1 and 2 (Survey & Detect) of the Skill Mining process.
Your goal is to identify latent, high-leverage skills and agents in the codebase.
Read the Candidate Taxonomy and Skill Mining guidelines.
Return your findings in JSON format ONLY. Do not write any conversational text.
`;

  const prompt = `
=== Candidate Taxonomy ===
${taxonomy}

=== Skill Mining Guidelines ===
${skillMiningDoc}

=== Codebase Survey ===
Target Path: ${survey.path}
Number of files: ${survey.filesCount}
File list (subset):
${survey.filesList}

Hotspot / Churn files:
${JSON.stringify(survey.git.hotspots, null, 2)}

Recent commit messages:
${survey.git.recentCommits.slice(0, 25).join("\n")}

Key Configurations:
${Object.entries(survey.configs).map(([pkg, text]) => `--- File: ${pkg} ---\n${text}`).join("\n\n")}

=== Task ===
Based on the survey above and the taxonomy, identify:
1. Candidate skills (build commands, rules, conventions, playbooks, deploy recipes).
2. Candidate agents (roles like Implementer, Fixer, Reviewer, Migrator, etc.).

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
  const response = await llmCall(llmConfig, prompt, systemInstruction, true);
  let parsed = JSON.parse(cleanJsonResponse(response));
  log.step(`Detected ${parsed.candidates.length} initial candidates`);

  // Run Completeness Critic
  log.step("Running Completeness Critic...");
  const criticPrompt = `
Here is the initial candidate list:
${JSON.stringify(parsed.candidates, null, 2)}

Here is the repo's file churn/hotspot map:
${JSON.stringify(survey.git.hotspots, null, 2)}

Analyze this list and the codebase. Assume the list is incomplete. Identify any high-leverage recurring knowledge that was missed (especially in build/test ops, domain invariants, and review checklists).
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
  ]
}
If nothing is missed, return {"newCandidates": []}.
`;

  const criticResponse = await llmCall(llmConfig, criticPrompt, systemInstruction, true);
  const criticParsed = JSON.parse(cleanJsonResponse(criticResponse));
  
  if (criticParsed.newCandidates && criticParsed.newCandidates.length > 0) {
    log.step(`Completeness Critic surfaced ${criticParsed.newCandidates.length} additional candidates`);
    parsed.candidates = parsed.candidates.concat(criticParsed.newCandidates);
  } else {
    log.step("Completeness Critic verified candidate list is comprehensive");
  }

  return parsed.candidates;
}

// ----------------------------------------------------
// Phase 3: Score
// ----------------------------------------------------
export async function runScorePhase(llmConfig, candidates) {
  log.phase("3", "Score (Rank by Leverage)");

  const rubric = await readPackageFile("skill-mining/references/scoring-rubric.md");

  const systemInstruction = `
You are an expert AI software architect scoring candidate skills and agents.
Apply the Scoring Rubric strictly.
Return your findings in JSON format ONLY. Do not write any conversational text.
`;

  const prompt = `
=== Scoring Rubric ===
${rubric}

=== Candidates ===
${JSON.stringify(candidates, null, 2)}

=== Task ===
Score each candidate on the five axes: Frequency (Freq), Leverage (Lev), Bespokeness (Bsp), Stability (Stab), and Verifiability (Ver) from 1 to 5.
Recommend a decision (BUILD, REUSE, EXTEND, REJECT) based on the rubric shapes:
- BUILD: High Bespokeness (4-5) AND High Leverage (4-5).
- REUSE: High Leverage, Low Bespokeness (1-2).
- EXTEND: High Leverage, Mid Bespokeness (3).
- REJECT: Low Frequency and Low Leverage (or low stability).

Return a JSON object with this exact shape:
{
  "scoredCandidates": [
    {
      "name": "kebab-case-name",
      "type": "skill", // or "agent"
      "description": "...",
      "evidence": "...",
      "example": "...",
      "scores": {
        "freq": 5,
        "lev": 4,
        "bsp": 3,
        "stab": 4,
        "ver": 4
      },
      "decision": "BUILD" // or REUSE, EXTEND, REJECT
    }
  ]
}
`;

  log.step("Scoring candidates against rubric...");
  const response = await llmCall(llmConfig, prompt, systemInstruction, true);
  const parsed = JSON.parse(cleanJsonResponse(response));
  log.step("Candidates scored successfully");
  return parsed.scoredCandidates;
}

// ----------------------------------------------------
// Gate A: Challenge the decision
// ----------------------------------------------------
export async function runGateA(llmConfig, scoredCandidates) {
  log.gate("A", "Challenge the decision");

  const adversarialReview = await readPackageFile("skill-mining/references/adversarial-review.md");

  const systemInstruction = `
You are the independent skeptic for Gate A. Your job is to refute the proposer's case for building new skills.
Default position: candidates should be REUSED or REJECTED.
Attack recurrence, bespokeness (name public skills), leverage, and stability.
Return your findings in JSON format ONLY. Do not write any conversational text.
`;

  const prompt = `
=== Adversarial Review Guidelines (Gate A) ===
${adversarialReview}

=== Scored Candidates ===
${JSON.stringify(scoredCandidates, null, 2)}

=== Task ===
Re-evaluate each candidate where decision is "BUILD" or "EXTEND".
1. Verify if the evidence supports the recurrence frequency.
2. Attack bespokeness: if this is a general software engineering practice (e.g. general React state, clean code, Git commits), argue that it should be REUSED or REJECTED.
3. Provide revised scores (adjusting down if inflated) and a final Gate A verdict.
4. Record the single strongest objection (or 'survived: <reason>' if the case for BUILD/EXTEND is genuinely unassailable).

Return a JSON object with this exact shape:
{
  "challengedCandidates": [
    {
      "name": "kebab-case-name",
      "type": "skill", // or "agent"
      "description": "...",
      "evidence": "...",
      "example": "...",
      "scores": {
        "freq": 4,
        "lev": 4,
        "bsp": 2, // downgraded
        "stab": 4,
        "ver": 4
      },
      "decision": "REUSE", // revised decision
      "objection": "Refuted bespokeness: general testing is covered by standard packages"
    }
  ]
}
Include all candidates (even REJECT/REUSE ones, keeping their decisions/scores or adjusting if needed).
`;

  log.step("Independent skeptic challenging proposing decisions...");
  const response = await llmCall(llmConfig, prompt, systemInstruction, true);
  const parsed = JSON.parse(cleanJsonResponse(response));
  log.step("Gate A challenges processed");
  return parsed.challengedCandidates;
}

// ----------------------------------------------------
// Phase 4: Dedupe (Ecosystem Search & Reuse Check)
// ----------------------------------------------------
export async function runDedupePhase(llmConfig, challengedCandidates, offlineMode) {
  log.phase("4", "Dedupe (Ecosystem Search)");
  
  const finalCandidates = [];

  for (const cand of challengedCandidates) {
    if (cand.type === "agent") {
      // Agents don't undergo registry search, they compose skills
      finalCandidates.push({
        ...cand,
        source: "this repo",
        justification: "Agent role composed of skills",
        reuseCheckStatus: "n/a"
      });
      continue;
    }

    if (cand.decision === "REJECT") {
      finalCandidates.push({
        ...cand,
        source: "n/a",
        justification: "Rejected during scoring/challenge",
        reuseCheckStatus: "n/a"
      });
      continue;
    }

    log.step(`Checking candidate: ${cand.name} (${cand.decision})`);

    // Perform ecosystem search
    let searchResult;
    try {
      searchResult = findEcosystemSkills(cand.name, offlineMode);
    } catch (err) {
      // Fail closed policy if online search failed and not in offline mode
      throw err;
    }

    let searchOutputStr = "";
    let reuseCheckStatus = "";
    if (searchResult.status === "offline") {
      reuseCheckStatus = `reuse-unchecked (offline @ ${new Date().toISOString()})`;
      searchOutputStr = "SEARCH UNAVAILABLE - RUNNING IN OFFLINE MODE";
    } else {
      reuseCheckStatus = `reuse-checked: ${cand.name} via npx skills find @ ${new Date().toISOString()}`;
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
  "finalDecision": "BUILD", // BUILD | REUSE | EXTEND | REJECT
  "source": "this repo", // or "user/repo@version" if REUSE/EXTEND
  "justification": "Why this decision was made in light of the search results"
}
`;

    log.step(`Analyzing search results for "${cand.name}"...`);
    const response = await llmCall(llmConfig, prompt, systemInstruction, true);
    const parsed = JSON.parse(cleanJsonResponse(response));
    
    // If we are offline and LLM tried to REUSE but we can't fetch it, we should flag it
    let finalDecision = parsed.finalDecision;
    let source = parsed.source;
    
    if (searchResult.status === "offline" && finalDecision === "BUILD") {
      // Mined offline, keep it as BUILD but flagged
      log.substep(`Offline Mode: Allowed local build of "${cand.name}" (marked reuse-unchecked)`);
    } else if (searchResult.status === "offline" && (finalDecision === "REUSE" || finalDecision === "EXTEND")) {
      // Cannot verify reuse version/source offline cleanly, default to BUILD with reuse-unchecked or keep the guess
      log.substep(`Offline Mode: Candidate "${cand.name}" matched to proposed reuse "${source}"`);
    }

    log.substep(`Final decision: ${finalDecision} (${source})`);

    finalCandidates.push({
      ...cand,
      decision: finalDecision,
      source: source,
      justification: parsed.justification,
      reuseCheckStatus: reuseCheckStatus
    });
  }

  return finalCandidates;
}

// ----------------------------------------------------
// Phase 5: Author (Write SKILL.md files)
// ----------------------------------------------------
export async function runAuthorPhase(llmConfig, targetDir, finalCandidates, survey) {
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
Return the raw markdown content ONLY. Do not wrap in markdown quotes or conversational text.
`;

    const prompt = `
=== Skill Template ===
${skillTemplate}

=== Candidate Skill Details ===
Name: ${cand.name}
Description: ${cand.description}
Evidence: ${cand.evidence}
Representative Example: ${cand.example}
Decision: ${cand.decision} (Source: ${cand.source})
Justification: ${cand.justification}

=== Codebase Survey ===
Files available: ${survey.filesCount}
Key configs: ${JSON.stringify(survey.configs, null, 2)}
Git hotspots: ${JSON.stringify(survey.git.hotspots, null, 2)}

=== Task ===
Write the SKILL.md file. Use the exact templated frontmatter, filling in name, description, license, user-invocable, metadata.
Make sure to fill in:
1. Title and description (trigger-rich, starting with "Use when...")
2. When to use list
3. Specific procedure steps (with real paths like package.json, test files, and real commands like pnpm test)
4. Specific rules/conventions
5. A clear, actionable Verification section (e.g. command to run or file state to check).

Write the complete markdown text.
`;

    const markdown = await llmCall(llmConfig, prompt, systemInstruction, false);
    
    authoredSkills.push({
      name: cand.name,
      decision: cand.decision,
      source: cand.source,
      justification: cand.justification,
      reuseCheckStatus: cand.reuseCheckStatus,
      rawMarkdown: markdown.trim()
    });
    
    log.substep(`Authored skill structure for "${cand.name}"`);
  }

  return authoredSkills;
}

// ----------------------------------------------------
// Gate B: Red-team the artifact
// ----------------------------------------------------
export async function runGateB(llmConfig, authoredSkills) {
  log.gate("B", "Red-team the artifact");

  const adversarialReview = await readPackageFile("skill-mining/references/adversarial-review.md");
  const verifiedSkills = [];

  for (const skill of authoredSkills) {
    log.step(`Red-teaming skill: "${skill.name}"...`);

    // Devise a test task relevant to the skill description/name
    const taskPrompt = `
Given this skill description, devise a realistic, concrete test task that an agent would execute in this codebase using this skill:
Skill: ${skill.name}
Markdown:
${skill.rawMarkdown.substring(0, 1000)}...
Return a simple 1-sentence description of the test task.
`;
    const testTask = await llmCall(llmConfig, taskPrompt, "Return a 1-sentence task description only.", false);
    log.substep(`Selected test task: "${testTask.trim()}"`);

    const systemInstruction = `
You are the cold-loaded adversarial reviewer for Gate B. Your job is to find gaps in the authored SKILL.md.
Assume the skill is inadequate. Do not use outside knowledge.
Review ONLY the attached SKILL.md.
Return your findings in JSON format ONLY. Do not write any conversational text.
`;

    const prompt = `
=== Adversarial Review Guidelines (Gate B) ===
${adversarialReview}

=== Authored SKILL.md ===
${skill.rawMarkdown}

=== Test Task ===
${testTask}

=== Task ===
Dry-run the test task using ONLY the instructions in the SKILL.md.
Identify any:
1. Ambiguous steps or incorrect commands/paths.
2. Missing details (assumed knowledge).
3. Issues in the Verification section (does it actually prove success?).
4. Decide on a verdict: SHIP (good as is), FIX (needs specific edits), or REJECT (not useful/meaningless).

Return a JSON object with this exact shape:
{
  "verdict": "SHIP", // SHIP | FIX | REJECT
  "objections": ["First objection", "Second objection"],
  "requestedEdits": "Specify exact line/section edits if verdict is FIX"
}
`;

    log.step("Independent skeptic testing skill usability...");
    const response = await llmCall(llmConfig, prompt, systemInstruction, true);
    const parsed = JSON.parse(cleanJsonResponse(response));
    
    log.substep(`Gate B Verdict: ${parsed.verdict}`);

    let finalMarkdown = skill.rawMarkdown;
    let verificationDetail = `**Gate B** @ ${new Date().toISOString().split("T")[0]}: used cold vs "${testTask.trim()}" → ${parsed.verdict}`;

    if (parsed.verdict === "FIX") {
      log.step(`Applying Gate B corrections for "${skill.name}"...`);
      const fixPrompt = `
=== Original SKILL.md ===
${skill.rawMarkdown}

=== Requested Edits ===
${parsed.requestedEdits}
Objections raised:
${parsed.objections.join("\n")}

=== Task ===
Apply these fixes directly into the SKILL.md text. Ensure it remains specific and follows all template guidelines.
Return the updated SKILL.md raw markdown content ONLY. Do not write conversational text.
`;
      const fixedMarkdown = await llmCall(llmConfig, fixPrompt, "Return only the updated markdown content.", false);
      finalMarkdown = fixedMarkdown.trim();
      verificationDetail += `; applied fixes for: ${parsed.objections.join(", ")}`;
      log.substep(`Updated SKILL.md with fixes`);
    } else if (parsed.verdict === "REJECT") {
      log.warn(`Skill "${skill.name}" was rejected by Gate B skeptic. Skipping authoring.`);
      continue;
    }

    verifiedSkills.push({
      ...skill,
      rawMarkdown: finalMarkdown,
      verification: verificationDetail,
      testTask: testTask.trim()
    });
  }

  return verifiedSkills;
}

// ----------------------------------------------------
// Phase 6: Compose (Agents & Team Manifest)
// ----------------------------------------------------
export async function runComposePhase(llmConfig, verifiedSkills, finalCandidates) {
  log.phase("6", "Compose (Mine the agents)");
  
  const agentTemplate = await readPackageFile("skill-mining/references/templates/agent-template.md");
  const composedAgents = [];

  // Find agent candidates that were not rejected
  const agentCands = finalCandidates.filter(c => c.type === "agent" && c.decision !== "REJECT");
  log.step(`Found ${agentCands.length} agent roles to compose`);

  for (const agent of agentCands) {
    log.step(`Composing agent role: "${agent.name}"...`);

    // Determine which skills this agent should load based on description/name
    const loadedSkills = verifiedSkills
      .filter(s => {
        // Simple heuristic: does the agent description mention it, or let the LLM map it
        return true; // We'll let the LLM choose from the list of verified skills
      })
      .map(s => s.name);

    const systemInstruction = `
You are an expert AI software architect composing agent role definitions (personas) that load and use mined skills.
Follow the Agent Template strictly.
Return the raw markdown content ONLY. Do not wrap in markdown quotes or conversational text.
`;

    const prompt = `
=== Agent Template ===
${agentTemplate}

=== Agent Role Details ===
Name: ${agent.name}
Description: ${agent.description}

=== Mined Skills Available ===
${JSON.stringify(verifiedSkills.map(s => ({ name: s.name, description: s.rawMarkdown.split("\n").slice(0, 10).join("\n") })), null, 2)}

=== Task ===
Write the agent definition markdown file. Fill in the frontmatter: name, description, loads_skills (select relevant ones from the list), capabilities.
Fill in:
1. Mandate / introduction.
2. Skills to load (briefly summarizing what each skill gives this agent).
3. Detailed operating procedure steps (incorporating the skills).
4. Team handoffs (triggers, inputs, outputs, handoffs - if not running with --no-team).
5. Boundaries.

Write the complete markdown text.
`;

    const markdown = await llmCall(llmConfig, prompt, systemInstruction, false);

    composedAgents.push({
      name: agent.name,
      description: agent.description,
      loadedSkills: loadedSkills, // populated inside LLM call
      rawMarkdown: markdown.trim()
    });

    log.substep(`Composed agent: "${agent.name}"`);
  }

  // Compose team manifest
  let teamManifestMarkdown = "";
  const activeAgents = composedAgents.map(a => a.name).join(", ");
  
  if (composedAgents.length > 0) {
    log.step("Composing team manifest workflow...");
    const manifestPrompt = `
Given these composed agents:
${JSON.stringify(composedAgents.map(a => ({ name: a.name, description: a.description })), null, 2)}

And these verified skills:
${JSON.stringify(verifiedSkills.map(s => ({ name: s.name, description: s.rawMarkdown.split("\n").slice(0, 5).join("\n") })), null, 2)}

Create a markdown table for the Team Manifest matching the template in report-template.md.
It must list: Persona, Loads skills, Triggered by, Receives, Produces, Hands off to (payload - proceed-when), Escalates when.
Also include the "Handoff loop" description (e.g. Implementer -> Reviewer -> Fixer -> Reviewer).
Return the markdown table and loop description ONLY. Do not write other text.
`;

    const manifestResult = await llmCall(llmConfig, manifestPrompt, "Return only the markdown team manifest section.", false);
    teamManifestMarkdown = manifestResult.trim();
    log.substep("Team manifest workflow established");
  }

  return {
    agents: composedAgents,
    teamManifest: teamManifestMarkdown
  };
}

// ----------------------------------------------------
// Phase 7: Verify & Report
// ----------------------------------------------------
export async function runReportPhase(llmConfig, targetDir, finalCandidates, verifiedSkills, composedAgentsResult, survey, args) {
  log.phase("7", "Verify & Report");
  
  const reportTemplate = await readPackageFile("skill-mining/references/templates/report-template.md");
  const absoluteTarget = path.resolve(targetDir);

  // Write skill files and compute fingerprints
  log.step("Writing skill files and computing directory fingerprints...");
  const skillDetails = [];
  
  for (const skill of verifiedSkills) {
    const skillDirName = skill.name;
    const skillDir = path.join(absoluteTarget, ".agents", "skills", skillDirName);
    await ensureDir(skillDir);
    
    // Write SKILL.md
    await fs.writeFile(path.join(skillDir, "SKILL.md"), skill.rawMarkdown, "utf8");
    log.substep(`Wrote SKILL.md to .agents/skills/${skillDirName}/`);

    // Compute fingerprint
    const fpResult = await generateSkillFingerprint(skillDir, skill.name);
    
    skillDetails.push({
      name: skill.name,
      decision: skill.decision,
      source: skill.source,
      path: `.agents/skills/${skillDirName}/`,
      fingerprint: fpResult.fingerprint,
      manifestText: fpResult.manifestText,
      verification: skill.verification,
      reuseCheckStatus: skill.reuseCheckStatus
    });
  }

  // Write agent files
  if (!args.noAgents && composedAgentsResult) {
    log.step("Writing agent files...");
    const agentsDir = path.join(absoluteTarget, ".agents", "agents");
    await ensureDir(agentsDir);
    
    for (const agent of composedAgentsResult.agents) {
      await fs.writeFile(path.join(agentsDir, `${agent.name}.md`), agent.rawMarkdown, "utf8");
      log.substep(`Wrote agent definition to .agents/agents/${agent.name}.md`);
    }
  }

  log.step("Synthesizing final SKILLS_MINED.md report...");
  const repoName = path.basename(absoluteTarget);
  const dateStr = new Date().toISOString().split("T")[0];

  const systemInstruction = `
You are an expert AI software architect synthesizing a final skill-mining report.
Follow the Report Template strictly. Fill in all placeholders.
Return the raw markdown content ONLY. Do not write conversational text.
`;

  const prompt = `
=== Report Template ===
${reportTemplate}

=== Run Metadata ===
Repo name: ${repoName}
Date: ${dateStr}
Scope: ${targetDir}
Exclusions: ${args.noAgents ? "Agents skipped (--no-agents)" : args.noTeam ? "Team manifest skipped (--no-team)" : "None"}

=== Candidate Ledger Details ===
Candidates ledger data:
${JSON.stringify(finalCandidates.map(c => ({
  name: c.name,
  type: c.type,
  freq: c.scores?.freq || 1,
  lev: c.scores?.lev || 1,
  bsp: c.scores?.bsp || 1,
  stab: c.scores?.stab || 1,
  ver: c.scores?.ver || 1,
  decision: c.decision,
  objection: c.objection || c.source || "n/a"
})), null, 2)}

=== Skills Identity Table ===
${JSON.stringify(skillDetails.map(s => ({
  name: s.name,
  origin: s.decision, // BUILD / EXTEND / REUSED
  path: s.path,
  source: s.source,
  fingerprint: s.fingerprint,
  verification: s.verification,
  reuseCheckStatus: s.reuseCheckStatus,
  manifestText: s.manifestText
})), null, 2)}

=== Composed Agents & Team Manifest ===
${(args.noAgents || !composedAgentsResult) ? "AGENTS SKIPPED BY USER CHOICE" : `
Agents list:
${composedAgentsResult.agents.map(a => `- **${a.name}** — loads ${a.loadedSkills.join(", ")}`).join("\n")}

Team Manifest:
${composedAgentsResult.teamManifest}
`}

=== Task ===
Synthesize the final SKILLS_MINED.md text.
Make sure to replace all template headers and placeholder values.
Include:
1. Summary numbers (total considered, count of built, reused, extended, rejected, and agents composed).
2. The complete Candidate ledger table (post-Gate A scores).
3. The Built / reused skills identity table.
4. The exact reuse-checked status for each built/extended skill.
5. The detailed per-skill file manifest sections (formatted exactly as in the template).
6. The Composed agents list (if not skipped).
7. The Team manifest table and handoff loop description (if not skipped).
8. The deferred candidates list.

Write the complete markdown text.
`;

  const finalReportMarkdown = await llmCall(llmConfig, prompt, systemInstruction, false);
  
  // Write report to root
  const reportPath = path.join(absoluteTarget, "SKILLS_MINED.md");
  await fs.writeFile(reportPath, finalReportMarkdown, "utf8");
  log.success(`Wrote mining report to: SKILLS_MINED.md`);
  
  return finalReportMarkdown;
}

// Helper to parse existing report for partial modes (--agents-only, --report-only)
export async function parseMinedReport(llmConfig, reportContent) {
  log.step("Parsing existing SKILLS_MINED.md report using LLM...");
  
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
      "origin": "BUILT", // or EXTEND, REUSED
      "path": ".agents/skills/name-of-skill/",
      "source": "...",
      "fingerprint": "sha256:...",
      "verification": "...",
      "reuseCheckStatus": "..."
    }
  ]
}
`;

  const response = await llmCall(llmConfig, prompt, systemInstruction, true);
  const parsed = JSON.parse(cleanJsonResponse(response));
  log.step(`Extracted ${parsed.skills.length} skills from report`);
  return parsed.skills;
}

