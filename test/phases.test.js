import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isScoreInflated,
  totalScore,
  enforceBuildCap,
  BUILD_CAP,
  runScorePhase,
  runAuthorPhase,
  runComposePhase,
  composeTeamManifest,
  parseMinedReport,
} from "../src/phases.js";
import { scoreDelta } from "../src/gates.js";

const scores = (n) => ({ freq: n, lev: n, bsp: n, stab: n, ver: n });

// Scripted-caller configs ride the llmConfig.caller seam (contract C4).
const scripted = (response) => ({ caller: async () => response });

test("isScoreInflated triggers when ≥70% of skills score ≥4 everywhere", () => {
  const inflated = [
    { type: "skill", scores: scores(5) },
    { type: "skill", scores: scores(4) },
    { type: "skill", scores: scores(5) },
    { type: "skill", scores: scores(2) },
  ];
  assert.equal(isScoreInflated(inflated), true);

  const healthy = [
    { type: "skill", scores: scores(5) },
    { type: "skill", scores: scores(2) },
    { type: "skill", scores: scores(3) },
    { type: "skill", scores: scores(2) },
  ];
  assert.equal(isScoreInflated(healthy), false);
});

test("isScoreInflated needs a minimum population", () => {
  assert.equal(isScoreInflated([{ type: "skill", scores: scores(5) }]), false);
});

test("totalScore sums the five axes", () => {
  assert.equal(totalScore({ scores: { freq: 1, lev: 2, bsp: 3, stab: 4, ver: 5 } }), 15);
  assert.equal(totalScore({ scores: {} }), 0);
});

test("enforceBuildCap defers lowest-scoring overflow, keeps non-build rows untouched", () => {
  const candidates = [
    ...Array.from({ length: BUILD_CAP + 3 }, (_, i) => ({
      name: `skill-${i}`,
      type: "skill",
      decision: "BUILD",
      scores: { freq: 5, lev: 5, bsp: 5, stab: 5, ver: (i % 5) + 1 },
    })),
    { name: "an-agent", type: "agent", decision: "BUILD", scores: scores(1) },
    { name: "rejected", type: "skill", decision: "REJECT", scores: scores(1) },
  ];

  const result = enforceBuildCap(candidates);
  const stillBuild = result.filter(c => c.type === "skill" && c.decision === "BUILD");
  const deferred = result.filter(c => c.decision === "DEFER");

  assert.equal(stillBuild.length, BUILD_CAP);
  assert.equal(deferred.length, 3);
  assert.ok(deferred.every(c => c.revisitWhen.includes("build cap")));
  assert.equal(result.find(c => c.name === "an-agent").decision, "BUILD", "agents not capped");
  assert.equal(result.find(c => c.name === "rejected").decision, "REJECT");
});

test("enforceBuildCap is a no-op under the cap and does not mutate input", () => {
  const candidates = [{ name: "a", type: "skill", decision: "BUILD", scores: scores(3) }];
  const result = enforceBuildCap(candidates);
  assert.equal(result[0].decision, "BUILD");
  assert.equal(candidates[0].revisitWhen, undefined);
});

test("runScorePhase collapses duplicate scored names — first occurrence wins", async () => {
  const candidates = [
    { name: "dup-skill", type: "skill", evidenceVerified: true, evidenceNotes: "all 1 cited path(s) exist in the repo" },
    { name: "other-skill", type: "skill", evidenceVerified: true, evidenceNotes: "ok" },
  ];
  const llmConfig = scripted(JSON.stringify({
    scoredCandidates: [
      { name: "dup-skill", type: "skill", scores: scores(3), decision: "DEFER", revisitWhen: "later" },
      { name: "dup-skill", type: "skill", scores: scores(5), decision: "BUILD" },
      { name: "other-skill", type: "skill", scores: scores(2), decision: "REJECT" },
    ],
  }));

  const result = await runScorePhase(llmConfig, candidates);

  const dups = result.filter(c => c.name === "dup-skill");
  assert.equal(dups.length, 1, "duplicate name must collapse to a single entry");
  assert.equal(dups[0].decision, "DEFER", "first occurrence wins");
  assert.equal(dups[0].evidenceVerified, true, "provenance re-attached from the detected candidate");
  assert.equal(result.filter(c => c.name === "other-skill").length, 1);
});

test("composeTeamManifest returns null when no agents survived", async () => {
  assert.equal(await composeTeamManifest(scripted("{}"), [], []), null);
});

test("composeTeamManifest returns a structured manifest and rewrites invalid handoff targets", async () => {
  const agents = [
    { name: "implementer", description: "implements", loadedSkills: ["run-tests-here"] },
    { name: "reviewer", description: "reviews", loadedSkills: [] },
  ];
  const llmConfig = scripted(JSON.stringify({
    loop: "implementer -> reviewer -> human",
    personas: [
      {
        persona: "implementer",
        loadsSkills: ["run-tests-here"],
        triggeredBy: "a task",
        receives: "spec",
        produces: "diff",
        handsOffTo: "reviewer",
        escalatesWhen: "blocked",
      },
      {
        persona: "reviewer",
        loadsSkills: "not-an-array",
        triggeredBy: "a diff",
        receives: "diff",
        produces: "verdict",
        handsOffTo: "ghost-agent",
        escalatesWhen: "unsure",
      },
    ],
  }));

  const manifest = await composeTeamManifest(llmConfig, agents, [{ name: "run-tests-here" }]);

  assert.equal(manifest.loop, "implementer -> reviewer -> human");
  assert.equal(manifest.personas.length, 2);
  assert.equal(manifest.personas[0].handsOffTo, "reviewer", "valid surviving-agent target kept");
  assert.equal(manifest.personas[1].handsOffTo, "human", "non-surviving target replaced with human");
  assert.deepEqual(manifest.personas[1].loadsSkills, [], "malformed loadsSkills coerced to array");
});

test("composeTeamManifest drops hallucinated persona rows and unknown loadsSkills entries", async () => {
  const agents = [
    { name: "implementer", description: "implements", loadedSkills: [] },
    { name: "reviewer", description: "reviews", loadedSkills: [] },
  ];
  const llmConfig = scripted(JSON.stringify({
    loop: "implementer -> reviewer -> human",
    personas: [
      { persona: "implementer", loadsSkills: ["run-tests-here", "nonexistent-skill"], handsOffTo: "reviewer" },
      { persona: "reviewer", loadsSkills: [], handsOffTo: "human" },
      // Hallucinated row: no agents/deployer.md was ever written
      { persona: "deployer", loadsSkills: ["nonexistent-skill"], handsOffTo: "implementer" },
    ],
  }));

  const manifest = await composeTeamManifest(llmConfig, agents, [{ name: "run-tests-here" }]);

  assert.deepEqual(manifest.personas.map(p => p.persona), ["implementer", "reviewer"],
    "persona rows not naming a surviving agent are dropped");
  assert.deepEqual(manifest.personas[0].loadsSkills, ["run-tests-here"],
    "loadsSkills entries not in the verified skill set are removed");
});

test("composeTeamManifest drops a loop that names a non-surviving persona", async () => {
  // The hallucinated deployer ROW is dropped, but the free-text loop string
  // naming it must not ship either — it would advertise a persona with no
  // written file via the report's "**Loop:**" line.
  const agents = [{ name: "implementer", description: "d", loadedSkills: [] }];
  const llmConfig = scripted(JSON.stringify({
    loop: "implementer -> deployer -> human",
    personas: [
      { persona: "implementer", loadsSkills: [], handsOffTo: "human" },
      { persona: "deployer", loadsSkills: [], handsOffTo: "implementer" },
    ],
  }));

  const manifest = await composeTeamManifest(llmConfig, agents, []);

  assert.deepEqual(manifest.personas.map(p => p.persona), ["implementer"]);
  assert.equal(manifest.loop, "", "a loop naming a dropped persona must not ship verbatim");
});

test("runComposePhase fails one agent closed when its composition call throws", async () => {
  const cands = [
    { name: "broken-agent", type: "agent", decision: "BUILD", description: "d" },
    { name: "good-agent", type: "agent", decision: "BUILD", description: "d" },
  ];
  let call = 0;
  const llmConfig = {
    caller: async () => {
      call++;
      if (call === 1) throw new Error("Anthropic response truncated at 16000 output tokens — output budget exhausted");
      return "---\nname: good-agent\ndescription: d\n---\n# Good Agent";
    },
  };

  const { agents } = await runComposePhase(llmConfig, [], cands, { noTeam: true });

  assert.equal(agents.length, 1, "the throwing agent is excluded, the run continues");
  assert.equal(agents[0].name, "good-agent");
});

test("composeTeamManifest degrades to null when no persona row names a surviving agent", async () => {
  const agents = [{ name: "implementer", description: "d", loadedSkills: [] }];
  const llmConfig = scripted(JSON.stringify({
    loop: "ghost -> human",
    personas: [{ persona: "ghost", loadsSkills: [], handsOffTo: "human" }],
  }));
  assert.equal(await composeTeamManifest(llmConfig, agents, []), null);
});

test("runAuthorPhase fails one candidate closed when its authoring call throws", async () => {
  const candidates = [
    { name: "broken-skill", type: "skill", decision: "BUILD", source: "this repo", justification: "j", reuseCheckStatus: "reuse-checked" },
    { name: "good-skill", type: "skill", decision: "BUILD", source: "this repo", justification: "j", reuseCheckStatus: "reuse-checked" },
  ];
  const survey = { filesCount: 1, treeSummary: "src/", configs: {}, git: { hotspots: [] }, sourceSamples: {} };
  let call = 0;
  const llmConfig = {
    caller: async () => {
      call++;
      if (call === 1) throw new Error("Anthropic response truncated at 16000 output tokens — output budget exhausted");
      return "# Good Skill\n\nAuthored.";
    },
  };

  const authored = await runAuthorPhase(llmConfig, candidates, survey);

  assert.equal(authored.length, 1, "the throwing candidate is excluded, the run continues");
  assert.equal(authored[0].name, "good-skill");
  assert.equal(authored[0].rawMarkdown, "# Good Skill\n\nAuthored.");
});

test("composeTeamManifest degrades to null when personas is not an array", async () => {
  const agents = [{ name: "implementer", description: "d", loadedSkills: [] }];
  const manifest = await composeTeamManifest(scripted(JSON.stringify({ loop: "x", personas: "nope" })), agents, []);
  assert.equal(manifest, null);
});

test("parseMinedReport returns skills plus DEFER/REJECT extraCandidates", async () => {
  const llmConfig = scripted(JSON.stringify({
    skills: [
      { name: "s1", origin: "BUILT", path: ".agents/skills/s1/", source: "this repo", fingerprint: "sha256:abc", verification: "v", reuseCheckStatus: "reuse-checked" },
    ],
    extraCandidates: [
      { name: "d1", decision: "DEFER", objection: "mid scores", revisitWhen: "after 5 more uses" },
      { name: "r1", decision: "reject", objection: "low leverage" },
      { name: "drifted", decision: "BUILD", objection: "must not pass the DEFER/REJECT filter" },
      { decision: "DEFER", objection: "nameless — dropped" },
    ],
  }));

  const { skills, extraCandidates } = await parseMinedReport(llmConfig, "# SKILLS_MINED.md");

  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, "s1");
  assert.equal(extraCandidates.length, 2);
  assert.deepEqual(extraCandidates.map(c => c.decision), ["DEFER", "REJECT"]);
  assert.ok(extraCandidates.every(c => c.type === "skill"));
  assert.equal(extraCandidates[0].revisitWhen, "after 5 more uses");
});

test("parseMinedReport fails closed when the extractor output has no skills array", async () => {
  // Schema drift ({"skill_list": [...]}, bare arrays, ...) must throw, never
  // degrade to "zero skills" — that would let a partial run overwrite the
  // legacy report and mint an empty authoritative sidecar.
  await assert.rejects(
    () => parseMinedReport(scripted(JSON.stringify({ skill_list: [{ name: "s1" }] })), "# SKILLS_MINED.md"),
    /schema drift/
  );
  await assert.rejects(
    () => parseMinedReport(scripted(JSON.stringify([{ name: "s1" }])), "# SKILLS_MINED.md"),
    /schema drift/
  );
});

test("scoreDelta sums absolute axis differences", () => {
  assert.equal(scoreDelta(scores(5), scores(3)), 10);
  assert.equal(scoreDelta(scores(4), scores(4)), 0);
  assert.equal(scoreDelta({}, scores(2)), 10);
});
