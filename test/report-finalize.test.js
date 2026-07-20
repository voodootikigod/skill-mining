import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runReportPhase, loadMinedState } from "../src/report.js";

const GOOD_SKILL_MD = `---
name: demo-skill
description: >-
  Use when exercising the report finalize path in the skill-mining test suite.
license: MIT
---

# Demo

Body text long enough to pass the trivially-short check. This skill exists only
to validate the deterministic finalize path of the mining pipeline.

## Verification

Run \`node --test\` — all tests pass.
`;

function makeSkill() {
  return {
    name: "demo-skill",
    decision: "BUILD",
    source: "this repo @ test",
    reuseCheckStatus: "reuse-checked: demo via npx skills find @ test",
    verification: '**Gate B** @ test: used cold vs "t" → SHIP; fixes: none',
    rawMarkdown: GOOD_SKILL_MD,
  };
}

const CANDIDATES = [
  { name: "demo-skill", type: "skill", scores: { freq: 5, lev: 4, bsp: 4, stab: 4, ver: 5 }, decision: "BUILD", objection: "survived", evidenceVerified: true },
];

const SURVEY = { filesCount: 1, sourceSamples: {}, painMarkers: { available: false }, git: { headCommit: "t" } };

test("a malformed agent frontmatter name does not prevent verified skills from being written", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sm-report-"));
  try {
    const badAgent = {
      name: "reviewer",
      loadedSkills: ["demo-skill"],
      // frontmatter name drifted from the agent's given name — lint error
      rawMarkdown: "---\nname: code-reviewer\ndescription: Reviews diffs.\n---\n\n# Reviewer\n",
    };

    const data = await runReportPhase(
      dir, CANDIDATES, [makeSkill()],
      { agents: [badAgent], teamManifest: null },
      SURVEY, { noAgents: false, noTeam: false }, {}
    );

    // Skill written, report + sidecar written, bad agent dropped (not thrown)
    const skillMd = await fs.readFile(path.join(dir, ".agents", "skills", "demo-skill", "SKILL.md"), "utf8");
    assert.match(skillMd, /demo-skill/);
    const state = await loadMinedState(dir);
    assert.equal(state.skills.length, 1);
    assert.equal(data.agents.length, 0, "bad agent excluded from report data");
    await assert.rejects(fs.access(path.join(dir, ".agents", "agents", "reviewer.md")), "bad agent file not written");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("state-loaded agent survives a report-only re-emit when its file exists on disk", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sm-report-"));
  try {
    // Backing file present — the persona is real and must be re-asserted
    await fs.mkdir(path.join(dir, ".agents", "agents"), { recursive: true });
    await fs.writeFile(path.join(dir, ".agents", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: x\n---\n", "utf8");

    const priorAgent = { name: "reviewer", loadedSkills: ["demo-skill"], verification: "**Agent gate** → SHIP" };
    const data = await runReportPhase(
      dir, CANDIDATES, [makeSkill()],
      { agents: [priorAgent], teamManifest: "| Persona | ... |" },
      SURVEY, { noAgents: false, noTeam: false }, { lintMode: "warn" }
    );
    assert.equal(data.agents.length, 1, "prior agent kept when its file exists");
    assert.equal(data.teamManifest, "| Persona | ... |");
    assert.match(await fs.readFile(path.join(dir, "SKILLS_MINED.md"), "utf8"), /`reviewer`/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("state-loaded agent is dropped from the report when its backing file is gone", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sm-report-"));
  try {
    // No .agents/agents/reviewer.md on disk — must NOT advertise the persona
    const priorAgent = { name: "reviewer", loadedSkills: ["demo-skill"], verification: "**Agent gate** → SHIP" };
    const data = await runReportPhase(
      dir, CANDIDATES, [makeSkill()],
      { agents: [priorAgent], teamManifest: "| Persona | ... |" },
      SURVEY, { noAgents: false, noTeam: false }, { lintMode: "warn" }
    );
    assert.equal(data.agents.length, 0, "missing-file agent dropped");
    assert.doesNotMatch(await fs.readFile(path.join(dir, "SKILLS_MINED.md"), "utf8"), /^- \*\*`reviewer`/m);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("--out-dir routes artifacts and is recorded in the sidecar; report stays at root", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sm-report-"));
  try {
    const agent = {
      name: "reviewer",
      loadedSkills: ["demo-skill"],
      rawMarkdown: "---\nname: reviewer\ndescription: Reviews diffs.\n---\n\n# Reviewer\n",
    };
    const data = await runReportPhase(
      dir, CANDIDATES, [makeSkill()],
      { agents: [agent], teamManifest: null },
      SURVEY, { noAgents: false, noTeam: false, outDir: "custom/tree" }, {}
    );

    assert.equal(data.outDir, "custom/tree");
    assert.equal(data.skills[0].path, "custom/tree/skills/demo-skill/");
    await fs.access(path.join(dir, "custom", "tree", "skills", "demo-skill", "SKILL.md"));
    await fs.access(path.join(dir, "custom", "tree", "agents", "reviewer.md"));
    await assert.rejects(fs.access(path.join(dir, ".agents")), "default tree untouched");

    // Report + sidecar remain at the repo root regardless of --out-dir
    await fs.access(path.join(dir, "SKILLS_MINED.md"));
    const state = await loadMinedState(dir);
    assert.equal(state.outDir, "custom/tree");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runReportPhase defaults outDir to .agents when args omit it", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sm-report-"));
  try {
    const data = await runReportPhase(dir, CANDIDATES, [makeSkill()], null, SURVEY, { noAgents: true }, {});
    assert.equal(data.outDir, ".agents");
    await fs.access(path.join(dir, ".agents", "skills", "demo-skill", "SKILL.md"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("skill lint failures still fail closed on full runs", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sm-report-"));
  try {
    const broken = { ...makeSkill(), rawMarkdown: "# no frontmatter at all\n" };
    await assert.rejects(
      runReportPhase(dir, CANDIDATES, [broken], null, SURVEY, { noAgents: true }, {}),
      /Artifact lint failed/
    );
    await assert.rejects(fs.access(path.join(dir, "SKILLS_MINED.md")), "nothing written on lint failure");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("partial-mode lintMode=warn re-emits despite legacy lint defects", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sm-report-"));
  try {
    // Legacy artifact: valid frontmatter but no "## Verification" heading
    const legacy = { ...makeSkill(), rawMarkdown: GOOD_SKILL_MD.replace("## Verification", "## Verify") };
    const data = await runReportPhase(dir, CANDIDATES, [legacy], null, SURVEY, { noAgents: true }, { lintMode: "warn" });
    assert.equal(data.skills.length, 1, "legacy skill still recorded");
    await fs.access(path.join(dir, "SKILLS_MINED.md"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
