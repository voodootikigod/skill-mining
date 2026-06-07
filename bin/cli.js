#!/usr/bin/env node

import fs from "fs/promises";
import path from "path";
import { 
  parseArgs, 
  log, 
  colors, 
  HELP_TEXT 
} from "../src/utils.js";
import { 
  configureLLM 
} from "../src/llm.js";
import { 
  surveyProject 
} from "../src/survey.js";
import { 
  verifySkillFingerprint 
} from "../src/fingerprint.js";
import {
  runDetectPhase,
  runScorePhase,
  runGateA,
  runDedupePhase,
  runAuthorPhase,
  runGateB,
  runComposePhase,
  runReportPhase,
  parseMinedReport
} from "../src/phases.js";

async function main() {
  // 1. Parse command-line args
  const args = parseArgs(process.argv);
  
  if (args.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  console.log(colors.bold(colors.cyan(`
╔══════════════════════════════════════════════════════════════════════╗
║                          SKILL MINING CLI                            ║
║     Extract and synthesize agent skills and teams from code          ║
╚══════════════════════════════════════════════════════════════════════╝
`)));

  let llmConfig;
  try {
    llmConfig = configureLLM(args);
  } catch (err) {
    log.error(err.message);
    process.exit(1);
  }

  const targetDir = args.target;
  const absoluteTarget = path.resolve(targetDir);
  const reportPath = path.join(absoluteTarget, "SKILLS_MINED.md");

  // 2. Project survey
  let survey;
  try {
    survey = await surveyProject(targetDir);
  } catch (err) {
    log.error(`Project survey failed: ${err.message}`);
    process.exit(1);
  }

  // ----------------------------------------------------
  // Partial Modes: --agents-only / --report-only
  // ----------------------------------------------------
  if (args.agentsOnly || args.reportOnly) {
    const modeName = args.agentsOnly ? "--agents-only" : "--report-only";
    log.info(`Running in partial mode: ${modeName}`);
    
    // Check if SKILLS_MINED.md exists
    let reportContent;
    try {
      reportContent = await fs.readFile(reportPath, "utf8");
    } catch (err) {
      log.error(`Required report file "SKILLS_MINED.md" not found at ${reportPath}.`);
      log.error(`Partial mode ${modeName} requires a previous full mining run. Please run a full mining pass first.`);
      process.exit(1);
    }

    try {
      // Parse report to get skills metadata
      const reportedSkills = await parseMinedReport(llmConfig, reportContent);
      const verifiedSkills = [];

      log.info("Verifying installed skills against fingerprints on disk...");
      
      for (const skill of reportedSkills) {
        const skillDir = path.join(absoluteTarget, skill.path);
        log.step(`Verifying skill "${skill.name}" at ${skill.path}...`);
        
        // 1. Check fingerprint on disk
        await verifySkillFingerprint(skillDir, skill.name, skill.fingerprint);
        log.substep("Fingerprint matches disk files successfully");

        // 2. Validate policies based on origin
        if (skill.origin === "BUILT" || skill.origin === "EXTEND") {
          // Must carry Gate B evidence
          if (!skill.verification.toLowerCase().includes("gate b")) {
            throw new Error(`Policy violation: BUILT/EXTEND skill "${skill.name}" is missing Gate B verification details.`);
          }
          // Must have a reuse check status
          if (!skill.reuseCheckStatus) {
            throw new Error(`Policy violation: BUILT/EXTEND skill "${skill.name}" is missing its reuse-check status.`);
          }
          // Check if it's still reuse-unchecked (i.e. built offline)
          if (skill.reuseCheckStatus.includes("reuse-unchecked") && !args.offline) {
            throw new Error(
              `Policy violation: Skill "${skill.name}" is marked "reuse-unchecked" (built offline) ` +
              `and must be re-mined in online mode. To override this for this session, pass the --offline flag.`
            );
          }
        } else if (skill.origin === "REUSED") {
          // Must carry a pinned source version (cannot be "this repo")
          if (skill.source.includes("this repo") || !skill.source.includes("@")) {
            throw new Error(`Policy violation: REUSED skill "${skill.name}" is missing a pinned source version (e.g. user/repo@version).`);
          }
        } else {
          throw new Error(`Unknown origin "${skill.origin}" for skill "${skill.name}".`);
        }

        // Load raw markdown from disk for composition/reporting
        const skillMd = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
        verifiedSkills.push({
          ...skill,
          rawMarkdown: skillMd
        });
      }

      log.success("All existing skills verified successfully (fingerprints + policies).");

      if (args.agentsOnly) {
        // Run Compose phase using verified skills
        const composedAgentsResult = await runComposePhase(llmConfig, verifiedSkills, reportedSkills.map(s => ({
          name: s.name,
          type: "agent",
          decision: "BUILD" // treat as active to recompose
        })));

        // Re-generate report containing new agents
        await runReportPhase(
          llmConfig,
          targetDir,
          reportedSkills.map(s => ({
            name: s.name,
            type: "skill",
            decision: s.origin,
            scores: { freq: 5, lev: 5, bsp: 5, stab: 5, ver: 5 }, // fallback scores for report
            objection: s.verification
          })),
          verifiedSkills,
          composedAgentsResult,
          survey,
          args
        );
      } else if (args.reportOnly) {
        // Re-synthesize report only
        await runReportPhase(
          llmConfig,
          targetDir,
          reportedSkills.map(s => ({
            name: s.name,
            type: "skill",
            decision: s.origin,
            scores: { freq: 5, lev: 5, bsp: 5, stab: 5, ver: 5 },
            objection: s.verification
          })),
          verifiedSkills,
          null, // skip agents
          survey,
          args
        );
      }

      log.success(`Partial run finished successfully. Output written to ${reportPath}`);
      process.exit(0);

    } catch (err) {
      log.error(`Verification failed: ${err.message}`);
      log.error("Please run a full mining pass to reconcile directories and recreate the report.");
      process.exit(1);
    }
  }

  // ----------------------------------------------------
  // Full Run Mode
  // ----------------------------------------------------
  try {
    // Phase 1 & 2: Survey & Detect
    const candidates = await runDetectPhase(llmConfig, survey);

    // Phase 3: Score
    const scoredCandidates = await runScorePhase(llmConfig, candidates);

    // Gate A: Challenge decisions
    const challengedCandidates = await runGateA(llmConfig, scoredCandidates);

    // Phase 4: Dedupe (Registry search)
    const finalCandidates = await runDedupePhase(llmConfig, challengedCandidates, args.offline);

    // Phase 5: Author (Write skills)
    const authoredSkills = await runAuthorPhase(llmConfig, targetDir, finalCandidates, survey);

    // Gate B: Red-team skills
    const verifiedSkills = await runGateB(llmConfig, authoredSkills);

    // Phase 6: Compose (Agents + Team Manifest)
    let composedAgentsResult = null;
    if (!args.noAgents) {
      composedAgentsResult = await runComposePhase(llmConfig, verifiedSkills, finalCandidates);
    }

    // Phase 7: Verify & Report (Writes report & skills to disk)
    await runReportPhase(
      llmConfig,
      targetDir,
      finalCandidates,
      verifiedSkills,
      composedAgentsResult,
      survey,
      args
    );

    console.log(colors.bold(colors.green(`
╔══════════════════════════════════════════════════════════════════════╗
║                    MINING SUCCESSFUL & COMPLETE                      ║
║  Mined skills and agents are written to: .agents/                    ║
║  Check the report at: SKILLS_MINED.md                                ║
╚══════════════════════════════════════════════════════════════════════╝
`)));

  } catch (err) {
    log.error(`Mining run failed: ${err.message}`);
    log.errorTrace(err);
    process.exit(1);
  }
}

main();
