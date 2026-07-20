#!/usr/bin/env node

import fs from "fs/promises";
import path from "path";
import {
  parseArgs,
  log,
  colors,
  HELP_TEXT,
  PACKAGE_VERSION,
  isSafePackageRef
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
  verifyCandidateEvidence,
  logEvidenceSummary
} from "../src/evidence.js";
import {
  searchForCandidates
} from "../src/dedupe.js";
import {
  runGateA,
  runGateB,
  runAgentGate
} from "../src/gates.js";
import {
  groundSkillArtifact
} from "../src/grounding.js";
import {
  runReportPhase,
  loadMinedState
} from "../src/report.js";
import {
  lintWithRepair,
  lintAgentArtifact,
  parseFrontmatter
} from "../src/lint.js";
import {
  runDetectPhase,
  runScorePhase,
  runCalibration,
  enforceBuildCap,
  runDedupeDecision,
  runAuthorPhase,
  runComposePhase,
  composeTeamManifest,
  parseMinedReport
} from "../src/phases.js";

// Survey bounds, surfaced in the report so a bounded pass never reads as exhaustive
const SURVEY_CAPS = [
  "prompt file list capped at 300 paths (full tree summary included)",
  "source samples capped at 12 files × 4000 chars",
  "churn/bug-fix windows: last 500 commits",
  "CI workflow files capped at 5",
];

// Reconstruct the agent roster from <outDir>/agents/*.md when only a legacy
// report (no JSON sidecar) is available — so partial-mode re-emit reflects the
// agent files actually on disk instead of implying an empty roster.
async function recoverAgentsFromDisk(absoluteTarget, outDir) {
  const agentsDir = path.join(absoluteTarget, outDir, "agents");
  let entries;
  try {
    entries = await fs.readdir(agentsDir);
  } catch (err) {
    return [];
  }
  const agents = [];
  for (const file of entries) {
    if (!file.endsWith(".md")) continue;
    const name = file.replace(/\.md$/, "");
    let loadedSkills = [];
    try {
      const md = await fs.readFile(path.join(agentsDir, file), "utf8");
      const fm = parseFrontmatter(md);
      const raw = fm.ok ? fm.data.loads_skills : "";
      if (raw) loadedSkills = raw.split(/[,\s]+/).filter(Boolean);
    } catch (err) {
      // unreadable — keep the name, skip skills
    }
    agents.push({ name, loadedSkills, verification: "recovered from disk (legacy report)" });
  }
  return agents;
}

// Derive an `npx skills add` hint from package.json's repository field, if
// any. Regex over the raw text rather than JSON.parse — the survey truncates
// large config files, which would make the JSON unparseable.
function deriveInstallHint(survey) {
  const raw = survey.configs?.["package.json"] || "";
  const m = raw.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?["\s/]/);
  return m ? m[1] : null;
}

async function main() {
  // 1. Parse command-line args
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  if (args.version) {
    console.log(PACKAGE_VERSION);
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
    survey = await surveyProject(targetDir, { outDir: args.outDir });
  } catch (err) {
    log.error(`Project survey failed: ${err.message}`);
    process.exit(1);
  }

  // ----------------------------------------------------
  // Partial Modes: --agents-only / --report-only
  // ----------------------------------------------------
  if (args.agentsOnly || args.reportOnly) {
    const modeName = args.agentsOnly ? "--agents-only" : "--report-only";

    // --dry-run promises "exit without writing anything to disk"; partial
    // modes exist only to (re)write artifacts. Refuse the combination rather
    // than silently overwriting SKILLS_MINED.md/json and <outDir>/agents/.
    if (args.dryRun) {
      log.error(`--dry-run cannot be combined with ${modeName}: partial modes only re-emit artifacts, and --dry-run guarantees nothing is written. Drop one of the two flags.`);
      process.exit(1);
    }

    log.info(`Running in partial mode: ${modeName}`);

    try {
      // Preferred: structured state sidecar (written by every full run).
      // Fallback: legacy LLM parse of the markdown report.
      const state = await loadMinedState(targetDir);
      let reportedSkills;
      let priorCandidates = null;
      let priorAgents = null;
      let extraCandidates = [];

      // Artifact root: an explicitly passed --out-dir always wins. Otherwise
      // the sidecar's recorded outDir wins over the flag DEFAULT so a re-emit
      // lands in the tree the prior run actually wrote.
      const outDir = args.outDirExplicit ? args.outDir : (state?.outDir || args.outDir);
      if (state?.outDir && state.outDir !== outDir) {
        log.warn(`--out-dir ${outDir} overrides the prior run's recorded output directory (${state.outDir}); artifacts will be written under ${outDir}/.`);
      }

      if (state) {
        log.step("Loaded structured state from SKILLS_MINED.json");
        reportedSkills = state.skills;
        priorCandidates = state.candidates || null;
        priorAgents = { agents: state.agents || [], teamManifest: state.teamManifest || "" };
      } else {
        let reportContent;
        try {
          reportContent = await fs.readFile(reportPath, "utf8");
        } catch (err) {
          log.error(`Required state not found: neither SKILLS_MINED.json nor SKILLS_MINED.md exists at ${absoluteTarget}.`);
          log.error(`Partial mode ${modeName} requires a previous full mining run. Please run a full mining pass first.`);
          process.exit(1);
        }
        // parseMinedReport also extracts DEFER/REJECT rows (extraCandidates)
        // so the reconstructed ledger doesn't silently drop them.
        const parsed = await parseMinedReport(llmConfig, reportContent);
        reportedSkills = parsed.skills;
        extraCandidates = parsed.extraCandidates || [];

        // No sidecar — reconstruct the agent roster from the files on disk so
        // --report-only doesn't claim "no agents" while <outDir>/agents/*.md
        // exist (a misrepresentation the report would otherwise make). The
        // team manifest can't be recovered from a legacy report; flag that.
        const recovered = await recoverAgentsFromDisk(absoluteTarget, outDir);
        if (recovered.length > 0) {
          log.step(`Recovered ${recovered.length} agent definition(s) from ${outDir}/agents/ (legacy report, no sidecar)`);
          priorAgents = {
            agents: recovered,
            teamManifest: "*Team manifest not recoverable from a legacy report (no SKILLS_MINED.json). Run a full pass to regenerate it.*",
          };
        }
      }

      const verifiedSkills = [];
      log.info("Verifying installed skills against fingerprints on disk...");

      for (const skill of reportedSkills) {
        const skillDir = path.join(absoluteTarget, skill.path);
        log.step(`Verifying skill "${skill.name}" at ${skill.path}...`);

        // 1. Check fingerprint on disk
        await verifySkillFingerprint(skillDir, skill.name, skill.fingerprint);
        log.substep("Fingerprint matches disk files successfully");

        // 2. Validate policies based on origin
        const origin = (skill.origin || "").toUpperCase();
        if (origin === "BUILT" || origin === "BUILD" || origin === "EXTEND" || origin === "EXTENDED") {
          // A Gate B mention alone is not enough — the recorded outcome must be
          // one the gate actually shipped. For 1.7.0+ artifacts that is SHIP;
          // v1.6.x legitimately shipped skills recording a fix-then-ship
          // outcome (no re-review): the in-memory shape was "→ FIX; applied
          // fixes for: …" but the LLM-rendered v1.6.x reports recorded a bare
          // "→ FIX" with no suffix, so both legacy shapes are accepted. Any
          // other non-SHIP line means the skill never cleared the gate and
          // must not be re-certified by a partial mode.
          const verification = skill.verification || "";
          const gateBShipped = /gate b/i.test(verification)
            && (/\bship\b/i.test(verification)
              || /(?:→|->)\s*FIX\b/i.test(verification)
              || /\bFIX;\s*applied fixes for:/i.test(verification));
          if (!gateBShipped) {
            throw new Error(
              `Policy violation: BUILT/EXTEND skill "${skill.name}" does not record a Gate B SHIP outcome ` +
              `(verification: "${verification || "(missing)"}"). Re-run a full mining pass.`
            );
          }
          if (!skill.reuseCheckStatus) {
            throw new Error(`Policy violation: BUILT/EXTEND skill "${skill.name}" is missing its reuse-check status.`);
          }
          if (skill.reuseCheckStatus.includes("reuse-unchecked") && !args.offline) {
            throw new Error(
              `Policy violation: Skill "${skill.name}" is marked "reuse-unchecked" (built offline) ` +
              `and must be re-mined in online mode. To override this for this session, pass the --offline flag.`
            );
          }
        } else if (origin === "REUSED" || origin === "REUSE") {
          // Strict package-ref validation, not a weak includes('@') test — the
          // source (LLM-parsed from a legacy report) becomes a copy-paste
          // `npx skills add` command, so an injected payload must be rejected.
          if (!isSafePackageRef(skill.source)) {
            throw new Error(`Policy violation: REUSED skill "${skill.name}" has an invalid source "${skill.source}" — expected a clean package reference (e.g. user/repo@version).`);
          }
        } else {
          throw new Error(`Unknown origin "${skill.origin}" for skill "${skill.name}".`);
        }

        const skillMd = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
        verifiedSkills.push({
          ...skill,
          decision: origin === "BUILT" ? "BUILD" : origin,
          rawMarkdown: skillMd
        });
      }

      log.success("All existing skills verified successfully (fingerprints + policies).");

      // Reconstruct the candidate ledger for the regenerated report; legacy
      // parses contribute their DEFER/REJECT rows too (extraCandidates)
      const candidates = priorCandidates || [
        ...reportedSkills.map(s => ({
          name: s.name,
          type: "skill",
          scores: null,
          decision: s.origin,
          objection: s.verification,
          source: s.source,
        })),
        ...extraCandidates,
      ];

      // --report-only must re-emit the prior roster faithfully — claiming "no
      // agents" while .agents/agents/*.md exist on disk misrepresents the run
      let composedAgentsResult = (!args.noAgents && priorAgents) ? priorAgents : null;
      if (args.agentsOnly) {
        const agentCandidates = (priorCandidates || []).filter(c => c.type === "agent" && c.decision !== "REJECT" && c.decision !== "DEFER");
        if (agentCandidates.length === 0) {
          log.warn("No agent candidates recorded in prior state — composing the default roster (Implementer, Fixer, Reviewer, Migrator).");
          agentCandidates.push(
            { name: "implementer", type: "agent", decision: "BUILD", description: "Builds features using the mined architecture and convention skills." },
            { name: "fixer", type: "agent", decision: "BUILD", description: "Diagnoses and repairs using the mined debugging and test skills." },
            { name: "reviewer", type: "agent", decision: "BUILD", description: "Enforces the mined convention and security skills as a review checklist." },
            { name: "migrator", type: "agent", decision: "BUILD", description: "Runs the mined build/deploy/migration skills safely." },
          );
        }
        composedAgentsResult = await runComposePhase(llmConfig, verifiedSkills, agentCandidates, { noTeam: args.noTeam });
        const { verifiedAgents } = await runAgentGate(llmConfig, composedAgentsResult.agents);
        const lintedAgents = verifiedAgents.filter(agent => {
          const errors = lintAgentArtifact({ name: agent.name, markdown: agent.rawMarkdown });
          if (errors.length > 0) {
            log.warn(`Agent "${agent.name}" failed lint — dropped: ${errors.join("; ")}`);
            return false;
          }
          return true;
        });
        const teamManifest = args.noTeam ? "" : await composeTeamManifest(llmConfig, lintedAgents, verifiedSkills);
        composedAgentsResult = { agents: lintedAgents, teamManifest };
      }

      await runReportPhase(
        targetDir,
        candidates,
        verifiedSkills,
        composedAgentsResult,
        survey,
        { ...args, outDir },
        // lintMode "warn": these skills may predate the current lint rules —
        // re-emitting a previously valid report must not hard-fail on them
        { caps: SURVEY_CAPS, installHint: deriveInstallHint(survey), lintMode: "warn" }
      );

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

    // Phase 2b: Deterministic evidence verification (no LLM) — catch
    // fabricated paths before the gates spend tokens on them
    const checkedCandidates = verifyCandidateEvidence(candidates, survey.allPaths);
    logEvidenceSummary(checkedCandidates);

    // Phase 3: Score (fast tier) + calibration guard
    const scoredCandidates = await runScorePhase(llmConfig, checkedCandidates);
    const calibratedCandidates = await runCalibration(llmConfig, scoredCandidates);

    // Phase 4a: Ecosystem search BEFORE Gate A — the skeptic attacks
    // bespokeness with real search output, not model memory
    const searchResults = await searchForCandidates(calibratedCandidates, args.offline);

    // Gate A: blind adversarial re-score
    const challengedCandidates = await runGateA(llmConfig, calibratedCandidates, searchResults);

    // Phase 4b: Reuse-vs-build decision + build cap
    const dedupedCandidates = await runDedupeDecision(llmConfig, challengedCandidates, searchResults);
    const finalCandidates = enforceBuildCap(dedupedCandidates);

    // --dry-run: stop before Phase 5 Author — every phase up to here is
    // read-only, so exiting now guarantees nothing touched the disk.
    if (args.dryRun) {
      log.phase("5", "Dry run — candidate ledger (nothing will be written)");
      for (const c of finalCandidates) {
        const s = c.scores || {};
        log.step(`${c.name} [${c.type}] → ${c.decision}`);
        log.substep(`scores: freq=${s.freq ?? "-"} lev=${s.lev ?? "-"} bsp=${s.bsp ?? "-"} stab=${s.stab ?? "-"} ver=${s.ver ?? "-"}`);
        if (c.objection || c.source) {
          log.substep(`${c.objection ? `objection: ${c.objection}` : `source: ${c.source}`}`);
        }
      }
      console.log(colors.bold(colors.yellow(`
╔══════════════════════════════════════════════════════════════════════╗
  Dry run — nothing written
  ${finalCandidates.length} candidate(s) evaluated through dedupe + build cap
╚══════════════════════════════════════════════════════════════════════╝
`)));
      process.exit(0);
    }

    // Phase 5: Author (Write skills)
    const authoredSkills = await runAuthorPhase(llmConfig, finalCandidates, survey);

    // Gate B: grounded red-team with closed FIX loop
    const { verifiedSkills: gatePassedSkills, rejectedSkills } = await runGateB(llmConfig, authoredSkills, survey);

    // Lint each surviving skill (one repair round); still-failing skills are
    // rejected, never shipped broken
    const verifiedSkills = [];
    for (const skill of gatePassedSkills) {
      // Same per-item fail-closed contract as authoring and Gate B: a throwing
      // lint-repair call (e.g. output-budget truncation) must reject only this
      // skill, never abort the run and discard every other verified skill.
      let linted;
      try {
        linted = await lintWithRepair(llmConfig, skill);
      } catch (err) {
        log.warn(`${err.message} — lint repair failed for "${skill.name}"; excluded (fail closed).`);
        rejectedSkills.push({ ...skill, gateBOutcome: `lint repair failed: ${err.message}` });
        continue;
      }
      if (linted.lintErrors.length > 0) {
        log.warn(`Skill "${skill.name}" failed lint after repair — excluded (fail closed).`);
        rejectedSkills.push({ ...skill, gateBOutcome: `lint failed: ${linted.lintErrors.join("; ")}` });
        continue;
      }
      // A lint repair rewrites the markdown with an LLM AFTER Gate B verified
      // it — re-ground the repaired text so a hallucinated path/script cannot
      // ship under the Gate B SHIP label. SHIP requires zero code-verified
      // grounding defects for the exact markdown that ships.
      if (linted.rawMarkdown !== skill.rawMarkdown) {
        const groundingDefects = groundSkillArtifact(linted.rawMarkdown, survey);
        if (groundingDefects.length > 0) {
          log.warn(`Skill "${skill.name}": lint repair introduced ${groundingDefects.length} grounding defect(s) — excluded (fail closed).`);
          rejectedSkills.push({ ...skill, gateBOutcome: `lint repair introduced grounding defects: ${groundingDefects.join("; ")}` });
          continue;
        }
      }
      verifiedSkills.push(linted);
    }

    // Reflect Gate B / lint rejections back into the candidate ledger. A
    // BUILD/EXTEND skill that failed authoring (per-candidate fail-closed in
    // runAuthorPhase) never reached Gate B — record it as REJECT too, so the
    // ledger never claims BUILD for a skill with no artifact on disk.
    const rejectedByName = new Map(rejectedSkills.map(s => [s.name, s]));
    const authoredNames = new Set(authoredSkills.map(s => s.name));
    const ledger = finalCandidates.map(c => {
      const rejected = rejectedByName.get(c.name);
      if (rejected) {
        return { ...c, decision: "REJECT", objection: rejected.gateBOutcome };
      }
      if (
        c.type === "skill"
        && (c.decision === "BUILD" || c.decision === "EXTEND")
        && !authoredNames.has(c.name)
      ) {
        return { ...c, decision: "REJECT", objection: "authoring failed (LLM call error) — excluded fail closed" };
      }
      return c;
    });

    // Phase 6: Compose (Agents + Team Manifest) + cold-load gate
    let composedAgentsResult = null;
    if (!args.noAgents) {
      composedAgentsResult = await runComposePhase(llmConfig, verifiedSkills, ledger, { noTeam: args.noTeam });

      // An agent whose composition call failed (per-agent fail-closed in
      // runComposePhase) has no artifact — record it as REJECT so the ledger
      // never claims a build-like decision for a persona with no written file.
      const composedNames = new Set(composedAgentsResult.agents.map(a => a.name));
      for (let i = 0; i < ledger.length; i++) {
        const c = ledger[i];
        if (c.type === "agent" && c.decision !== "REJECT" && c.decision !== "DEFER" && !composedNames.has(c.name)) {
          ledger[i] = { ...c, decision: "REJECT", objection: "agent composition failed (LLM call error) — excluded fail closed" };
        }
      }

      const { verifiedAgents, rejectedAgents } = await runAgentGate(llmConfig, composedAgentsResult.agents);

      // Deterministic agent lint: a drifted frontmatter name must drop the
      // agent here (recorded as REJECT), never abort the report and discard
      // the verified skills
      const lintedAgents = verifiedAgents.filter(agent => {
        const errors = lintAgentArtifact({ name: agent.name, markdown: agent.rawMarkdown });
        if (errors.length > 0) {
          log.warn(`Agent "${agent.name}" failed lint — dropped: ${errors.join("; ")}`);
          rejectedAgents.push(agent);
          return false;
        }
        return true;
      });

      // Manifest is composed from SURVIVORS only — composing earlier would
      // wire handoffs to agents whose files were never written
      const teamManifest = args.noTeam ? "" : await composeTeamManifest(llmConfig, lintedAgents, verifiedSkills);
      composedAgentsResult = { agents: lintedAgents, teamManifest };
      for (const dropped of rejectedAgents) {
        const idx = ledger.findIndex(c => c.name === dropped.name && c.type === "agent");
        if (idx !== -1) {
          ledger[idx] = { ...ledger[idx], decision: "REJECT", objection: "failed agent gate (cold-load or lint)" };
        }
      }
    }

    // Phase 7: Verify & Report (deterministic; writes artifacts + JSON sidecar)
    const reportData = await runReportPhase(
      targetDir,
      ledger,
      verifiedSkills,
      composedAgentsResult,
      survey,
      args,
      { caps: SURVEY_CAPS, installHint: deriveInstallHint(survey) }
    );

    // Banner reflects the real outcome — "SUCCESSFUL" over a 0-built report
    // (e.g. registry degraded everything to DEFER) misleads anyone who doesn't
    // read the ledger.
    const builtCount = reportData.skills.length;
    const deferredCount = reportData.candidates.filter(c => c.decision === "DEFER").length;
    const headline = builtCount > 0
      ? `MINING COMPLETE — ${builtCount} skill(s) built, ${deferredCount} deferred`
      : `MINING COMPLETE — 0 built, ${deferredCount} deferred (check the ledger)`;
    const color = builtCount > 0 ? colors.green : colors.yellow;
    console.log(colors.bold(color(`
╔══════════════════════════════════════════════════════════════════════╗
  ${headline}
  Artifacts: ${args.outDir}/   ·   Report: SKILLS_MINED.md
╚══════════════════════════════════════════════════════════════════════╝
`)));

  } catch (err) {
    log.error(`Mining run failed: ${err.message}`);
    log.errorTrace(err);
    process.exit(1);
  }
}

main();
