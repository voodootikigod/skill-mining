import { test } from "node:test";
import assert from "node:assert/strict";
import { runGateA } from "../src/gates.js";

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
