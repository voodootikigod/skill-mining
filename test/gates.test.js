import { test } from "node:test";
import assert from "node:assert/strict";
import { runGateA, runGateB, isRiskRelevant } from "../src/gates.js";

// Scripted LLM via the C4 injectability seam: returns canned responses in
// order and records every invocation, so tests can count calls and inspect
// the exact prompts each gate built. Throws when the script runs dry — an
// unexpected extra model call is itself a test failure.
function makeScriptedCaller(responses) {
  const calls = [];
  const caller = async (_config, prompt, systemInstruction, jsonMode, tier) => {
    calls.push({ prompt, systemInstruction, jsonMode, tier });
    if (calls.length > responses.length) {
      throw new Error(`Scripted caller exhausted after ${responses.length} response(s) — unexpected call #${calls.length}`);
    }
    const scripted = responses[calls.length - 1];
    // An Error entry scripts a FAILING call (e.g. output-budget truncation)
    if (scripted instanceof Error) throw scripted;
    return scripted;
  };
  return { calls, config: { provider: "anthropic", apiKey: null, models: {}, caller } };
}

// Routed scripted caller for multi-item gate tests: runGateB/runAgentGate now
// process items concurrently, so a single positional script would misdeliver
// responses when per-item call order interleaves. Each call is matched to the
// first route whose regex matches the prompt and consumes that route's queue
// in order. A dry queue (or unmatched prompt) throws — an unexpected extra
// model call is itself a test failure.
function makeRoutedCaller(routes) {
  const calls = [];
  const queues = routes.map(([re, responses]) => ({ re, responses: [...responses] }));
  const caller = async (_config, prompt, systemInstruction, jsonMode, tier) => {
    calls.push({ prompt, systemInstruction, jsonMode, tier });
    const queue = queues.find(({ re }) => re.test(prompt));
    if (!queue) throw new Error(`Routed caller: no route matches prompt: ${prompt.slice(0, 120)}`);
    if (queue.responses.length === 0) throw new Error(`Routed caller: queue for ${queue.re} exhausted — unexpected extra call`);
    const scripted = queue.responses.shift();
    if (scripted instanceof Error) throw scripted;
    return scripted;
  };
  return { calls, config: { provider: "anthropic", apiKey: null, models: {}, caller } };
}

const SCORES = { freq: 4, lev: 4, bsp: 4, stab: 4, ver: 4 };
const SURVEY = {
  allPaths: ["src/index.js"],
  configs: {},
  git: { recentCommits: ["abc123 fix: adjust widget"] },
  treeSummary: "src/",
  extHistogram: ".js: 1",
};

// ----------------------------------------------------
// Gate A
// ----------------------------------------------------

test("Gate A never challenges agent candidates — a BUILD agent survives untouched", async () => {
  const candidates = [
    { name: "implementer", type: "agent", decision: "BUILD", scores: { freq: 4, lev: 4, bsp: 4, stab: 4, ver: 4 } },
    { name: "rejected-skill", type: "skill", decision: "REJECT", scores: { freq: 1, lev: 1, bsp: 1, stab: 1, ver: 1 } },
  ];

  // No skill BUILD/EXTEND candidates → the gate must return without any LLM
  // call. A bogus llmConfig proves it: any model invocation would throw.
  const result = await runGateA({ provider: "anthropic", apiKey: null, models: {} }, candidates, {});

  const agent = result.find(c => c.name === "implementer");
  assert.equal(agent.decision, "BUILD", "agent not demoted by the skill-shaped skeptic");
  assert.equal(result.find(c => c.name === "rejected-skill").decision, "REJECT");
});

test("Gate A defers a candidate the skeptic returned no verdict for", async () => {
  const { config } = makeScriptedCaller([
    JSON.stringify({ challengedCandidates: [] }),
  ]);
  const candidates = [
    { name: "table-formatter", type: "skill", decision: "BUILD", scores: SCORES, description: "formats tables", evidence: "src/tables.js" },
  ];

  const result = await runGateA(config, candidates, {});
  assert.equal(result[0].decision, "DEFER");
  assert.match(result[0].objection, /no skeptic verdict/);
});

test("isRiskRelevant is word-anchored — prose lookalikes are not risk-relevant", () => {
  assert.equal(isRiskRelevant({ name: "doc-authoring-conventions" }), false);
  assert.equal(isRiskRelevant({ name: "product-catalog" }), false);
  assert.equal(isRiskRelevant({ name: "markdown-tokenizer" }), false);
  assert.equal(isRiskRelevant({ name: "bug-repro", evidence: "reproduce the bug locally" }), false);
  // ...while the real risk words still match
  assert.equal(isRiskRelevant({ name: "oauth-helper" }), true);
  assert.equal(isRiskRelevant({ name: "authorization-checker" }), true);
  assert.equal(isRiskRelevant({ name: "token-rotation" }), true);
});

test("isRiskRelevant matches risk keywords across name/description/evidence", () => {
  assert.equal(isRiskRelevant({ name: "release-helper" }), true);
  assert.equal(isRiskRelevant({ name: "x", description: "manages auth tokens" }), true);
  assert.equal(isRiskRelevant({ name: "x", evidence: "used across prod deploys" }), true);
  assert.equal(isRiskRelevant({ name: "x", evidence: { note: "secret rotation" } }), true, "non-string evidence is stringified");
  assert.equal(isRiskRelevant({ name: "db-migration-runner", description: "runs migrations" }), true);
  assert.equal(isRiskRelevant({ name: "markdown-formatter", description: "formats tables", evidence: "src/format.js" }), false);
  assert.equal(isRiskRelevant({ name: "json-cleaner" }), false);
});

test("Gate A multi-skeptic: any REJECT among 3 verdicts vetoes a risk-relevant BUILD", async () => {
  const batch = JSON.stringify({ challengedCandidates: [
    { name: "deploy-pipeline-guard", scores: SCORES, verdict: "BUILD", objection: "survived: recurrence proven" },
  ] });
  const extraReject = JSON.stringify({ challengedCandidates: [
    { name: "deploy-pipeline-guard", scores: SCORES, verdict: "REJECT", objection: "generic advice" },
  ] });
  const extraBuild = JSON.stringify({ challengedCandidates: [
    { name: "deploy-pipeline-guard", scores: SCORES, verdict: "BUILD", objection: "survived" },
  ] });
  const { calls, config } = makeScriptedCaller([batch, extraReject, extraBuild]);
  const candidates = [
    { name: "deploy-pipeline-guard", type: "skill", decision: "BUILD", scores: SCORES, description: "guards deploys", evidence: "ci/deploy.yml" },
  ];

  const result = await runGateA(config, candidates, {});
  assert.equal(calls.length, 3, "batch skeptic + 2 panel skeptics");
  assert.equal(result[0].decision, "REJECT");
  assert.match(result[0].objection, /multi-skeptic veto/);
  assert.equal(result[0].gateAVotes.length, 3);
  assert.deepEqual(result[0].gateAVotes.map(v => v.verdict), ["BUILD", "REJECT", "BUILD"]);
});

test("Gate A multi-skeptic: 2-of-3 build-like majority lets BUILD stand", async () => {
  const verdictJson = (verdict) => JSON.stringify({ challengedCandidates: [
    { name: "secure-token-store", scores: SCORES, verdict, objection: "n/a" },
  ] });
  const { calls, config } = makeScriptedCaller([verdictJson("BUILD"), verdictJson("EXTEND"), verdictJson("DEFER")]);
  const candidates = [
    { name: "secure-token-store", type: "skill", decision: "BUILD", scores: SCORES, description: "stores tokens", evidence: "src/auth.js" },
  ];

  const result = await runGateA(config, candidates, {});
  assert.equal(calls.length, 3);
  assert.equal(result[0].decision, "BUILD", "BUILD/EXTEND/DEFER is a build-like majority");
  assert.deepEqual(result[0].gateAVotes.map(v => v.verdict), ["BUILD", "EXTEND", "DEFER"]);
});

test("Gate A multi-skeptic: no build majority and no veto defers with the split named", async () => {
  const verdictJson = (verdict) => JSON.stringify({ challengedCandidates: [
    { name: "payment-retry-flow", scores: SCORES, verdict, objection: "n/a" },
  ] });
  const { config } = makeScriptedCaller([verdictJson("BUILD"), verdictJson("DEFER"), verdictJson("REUSE")]);
  const candidates = [
    { name: "payment-retry-flow", type: "skill", decision: "BUILD", scores: SCORES, description: "retries payments", evidence: "src/billing.js" },
  ];

  const result = await runGateA(config, candidates, {});
  assert.equal(result[0].decision, "DEFER");
  assert.match(result[0].objection, /multi-skeptic split \(BUILD\/DEFER\/REUSE\)/);
  assert.equal(result[0].gateAVotes.length, 3);
});

test("Gate A multi-skeptic: non-risk candidates get exactly one skeptic call", async () => {
  const { calls, config } = makeScriptedCaller([
    JSON.stringify({ challengedCandidates: [
      { name: "markdown-table-helper", scores: SCORES, verdict: "BUILD", objection: "survived" },
    ] }),
  ]);
  const candidates = [
    { name: "markdown-table-helper", type: "skill", decision: "BUILD", scores: SCORES, description: "formats tables", evidence: "src/tables.js" },
  ];

  const result = await runGateA(config, candidates, {});
  assert.equal(calls.length, 1, "no panel for non-risk candidates");
  assert.equal(result[0].decision, "BUILD");
  assert.equal(result[0].gateAVotes, undefined);
});

// ----------------------------------------------------
// Gate B
// ----------------------------------------------------

const SKILL = { name: "widget-fixing", rawMarkdown: "# Widget Fixing\n\nOriginal instructions." };

test("Gate B ships the FIXED markdown after one FIX round, with grounded prompts", async () => {
  const fixedText = "# Widget Fixing\n\nFixed instructions.";
  const { calls, config } = makeScriptedCaller([
    JSON.stringify({ task: "redo the widget fix", commit: "abc123" }),          // pickTestTask
    JSON.stringify({ verdict: "FIX", objections: ["path wrong"], requestedEdits: "correct the path" }), // review round 1
    fixedText,                                                                   // fix call
    JSON.stringify({ verdict: "SHIP", objections: [] }),                         // review round 2
  ]);

  const { verifiedSkills, rejectedSkills } = await runGateB(config, [SKILL], SURVEY);

  assert.equal(verifiedSkills.length, 1);
  assert.equal(rejectedSkills.length, 0);
  assert.equal(verifiedSkills[0].rawMarkdown, fixedText, "the shipped markdown is the FIXED text");
  assert.match(verifiedSkills[0].verification, /SHIP/);

  // Contract C7: every review round carries the deterministic grounding section
  assert.match(calls[1].prompt, /Deterministic ground-truth defects/);
  assert.match(calls[3].prompt, /Deterministic ground-truth defects/);
  // The FIX prompt carries the test task, ground truth, and grounding findings
  assert.match(calls[2].prompt, /redo the widget fix/);
  assert.match(calls[2].prompt, /REPO GROUND TRUTH/);
  assert.match(calls[2].prompt, /Deterministic ground-truth defects/);
});

test("Gate B rejects after exhausting fix rounds WITHOUT a wasted final fix call", async () => {
  const review = (verdict) => JSON.stringify({ verdict, objections: ["still wrong"], requestedEdits: "edit more" });
  // MAX_FIX_ROUNDS=2 → 3 reviews, 2 fixes. A 7th call (fix after the final
  // FIX verdict) would exhaust the script and fail the run.
  const { calls, config } = makeScriptedCaller([
    JSON.stringify({ task: "redo the widget fix", commit: "abc123" }), // pickTestTask
    review("FIX"),   // round 1
    "fixed once",    // fix 1
    review("FIX"),   // round 2
    "fixed twice",   // fix 2
    review("FIX"),   // round 3 (final) — must NOT trigger another fix
  ]);

  const { verifiedSkills, rejectedSkills } = await runGateB(config, [SKILL], SURVEY);

  assert.equal(calls.length, 6, "no strong-model fix call after the final review round");
  assert.equal(verifiedSkills.length, 0);
  assert.equal(rejectedSkills.length, 1);
  assert.match(rejectedSkills[0].gateBOutcome, /did not reach SHIP within 2 fix round/);
});

test("Gate B: a reviewer SHIP cannot overrule code-verified grounding defects", async () => {
  // The skill cites src/ghost.js (not in SURVEY.allPaths). The reviewer
  // rubber-stamps SHIP anyway — the gate must downgrade to FIX, repair, and
  // only ship once the re-grounded artifact is clean.
  const ghostSkill = { name: "ghost-skill", rawMarkdown: "# Ghost\n\nEdit src/ghost.js." };
  const cleanFixed = "# Ghost\n\nEdit src/index.js.";
  const { calls, config } = makeScriptedCaller([
    JSON.stringify({ task: "redo the widget fix", commit: "abc123" }), // pickTestTask
    JSON.stringify({ verdict: "SHIP", objections: [] }),               // round 1: rubber-stamp SHIP → downgraded to FIX
    cleanFixed,                                                         // fix call repairs the cited path
    JSON.stringify({ verdict: "SHIP", objections: [] }),               // round 2: clean grounding → SHIP stands
  ]);

  const { verifiedSkills, rejectedSkills } = await runGateB(config, [ghostSkill], SURVEY);

  assert.equal(rejectedSkills.length, 0);
  assert.equal(verifiedSkills.length, 1);
  assert.equal(verifiedSkills[0].rawMarkdown, cleanFixed, "the shipped markdown is the repaired text");
  // The fix prompt carried the deterministic defect as an objection
  assert.match(calls[2].prompt, /cited path src\/ghost\.js does not exist in the repo/);
});

test("Gate B: persistent grounding defects fail closed despite repeated SHIP verdicts", async () => {
  const ghostSkill = { name: "ghost-skill", rawMarkdown: "# Ghost\n\nEdit src/ghost.js." };
  const ship = JSON.stringify({ verdict: "SHIP", objections: [] });
  const stillBroken = "# Ghost\n\nEdit src/ghost.js (still).";
  const { config } = makeScriptedCaller([
    JSON.stringify({ task: "redo the widget fix", commit: "abc123" }), // pickTestTask
    ship, stillBroken,   // round 1: SHIP downgraded → fix keeps the fabricated path
    ship, stillBroken,   // round 2: same
    ship,                // round 3 (final): downgraded FIX cannot be re-reviewed → reject
  ]);

  const { verifiedSkills, rejectedSkills } = await runGateB(config, [ghostSkill], SURVEY);

  assert.equal(verifiedSkills.length, 0);
  assert.equal(rejectedSkills.length, 1);
  assert.match(rejectedSkills[0].gateBOutcome, /did not reach SHIP within 2 fix round/);
});

test("Gate B: a throwing fix-application call rejects only that skill, others still ship", async () => {
  // A truncation throw from the strong-model fix call must fail THIS skill
  // closed, not escape runGateB and discard every other verified skill.
  // Routed per skill: the two skills' calls interleave under mapLimit.
  const skill2 = { name: "other-skill", rawMarkdown: "# Other Skill\n\nInstructions." };
  const { config } = makeRoutedCaller([
    [/widget-fixing|Widget Fixing/, [
      JSON.stringify({ task: "task one", commit: "none" }),                                       // pickTestTask
      JSON.stringify({ verdict: "FIX", objections: ["path wrong"], requestedEdits: "fix it" }),   // review round 1
      new Error("Anthropic response truncated at 16000 output tokens — output budget exhausted"), // fix call throws
    ]],
    [/other-skill|Other Skill/, [
      JSON.stringify({ task: "task two", commit: "none" }), // pickTestTask
      JSON.stringify({ verdict: "SHIP", objections: [] }),  // review
    ]],
  ]);

  const { verifiedSkills, rejectedSkills } = await runGateB(config, [SKILL, skill2], SURVEY);

  assert.equal(rejectedSkills.length, 1);
  assert.equal(rejectedSkills[0].name, "widget-fixing");
  assert.match(rejectedSkills[0].gateBOutcome, /REJECTED/);
  assert.equal(verifiedSkills.length, 1);
  assert.equal(verifiedSkills[0].name, "other-skill");
});

test("Gate B: an unparseable verdict rejects only that skill, others still ship", async () => {
  const skill2 = { name: "other-skill", rawMarkdown: "# Other Skill\n\nInstructions." };
  const { config } = makeRoutedCaller([
    [/widget-fixing|Widget Fixing/, [
      JSON.stringify({ task: "task one", commit: "none" }), // pickTestTask
      "utterly not json",                                    // review attempt 1
      "still not json",                                      // review attempt 2 (llmCallJson retry)
    ]],
    [/other-skill|Other Skill/, [
      JSON.stringify({ task: "task two", commit: "none" }), // pickTestTask
      JSON.stringify({ verdict: "SHIP", objections: [] }),  // review
    ]],
  ]);

  const { verifiedSkills, rejectedSkills } = await runGateB(config, [SKILL, skill2], SURVEY);

  assert.equal(rejectedSkills.length, 1);
  assert.equal(rejectedSkills[0].name, "widget-fixing");
  assert.match(rejectedSkills[0].gateBOutcome, /REJECTED/);
  assert.equal(verifiedSkills.length, 1);
  assert.equal(verifiedSkills[0].name, "other-skill");
});

test("Gate B: a throwing pickTestTask call rejects only that skill, others still ship", async () => {
  // The task-pick call is the first LLM call of the per-skill pipeline — a
  // retry-exhausted failure there must fail THIS skill closed, not escape
  // runGateB and discard every other verified skill.
  const skill2 = { name: "other-skill", rawMarkdown: "# Other Skill\n\nInstructions." };
  const { config } = makeRoutedCaller([
    [/widget-fixing|Widget Fixing/, [
      new Error("Anthropic API error 429: rate limited — retries exhausted"), // pickTestTask throws
    ]],
    [/other-skill|Other Skill/, [
      JSON.stringify({ task: "task two", commit: "none" }), // pickTestTask
      JSON.stringify({ verdict: "SHIP", objections: [] }),  // review
    ]],
  ]);

  const { verifiedSkills, rejectedSkills } = await runGateB(config, [SKILL, skill2], SURVEY);

  assert.equal(rejectedSkills.length, 1);
  assert.equal(rejectedSkills[0].name, "widget-fixing");
  assert.match(rejectedSkills[0].gateBOutcome, /test-task selection failed/);
  assert.equal(verifiedSkills.length, 1);
  assert.equal(verifiedSkills[0].name, "other-skill");
});

test("Gate B processes two skills concurrently and still returns them in input order", async () => {
  // In-flight counter in the scripted caller: with GATE_B_CONCURRENCY=2 the
  // two skills' calls must overlap. Every call parks on a timer so the second
  // skill's first call arrives while the first skill's is still pending.
  let inFlight = 0;
  let maxInFlight = 0;
  const queues = new Map([
    ["alpha", [
      JSON.stringify({ task: "alpha task", commit: "none" }),
      JSON.stringify({ verdict: "SHIP", objections: [] }),
    ]],
    ["beta", [
      JSON.stringify({ task: "beta task", commit: "none" }),
      JSON.stringify({ verdict: "SHIP", objections: [] }),
    ]],
  ]);
  const caller = async (_config, prompt) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 10));
    inFlight--;
    const queue = queues.get(prompt.includes("alpha-skill") ? "alpha" : "beta");
    if (queue.length === 0) throw new Error("queue exhausted — unexpected extra call");
    return queue.shift();
  };
  const config = { provider: "anthropic", apiKey: null, models: {}, caller };
  const skills = [
    { name: "alpha-skill", rawMarkdown: "# Alpha\n\nalpha-skill instructions." },
    { name: "beta-skill", rawMarkdown: "# Beta\n\nbeta-skill instructions." },
  ];

  const { verifiedSkills, rejectedSkills } = await runGateB(config, skills, SURVEY);

  assert.equal(maxInFlight, 2, "both skills' model calls were in flight simultaneously");
  assert.equal(rejectedSkills.length, 0);
  assert.deepEqual(verifiedSkills.map(s => s.name), ["alpha-skill", "beta-skill"], "input order preserved");
});
