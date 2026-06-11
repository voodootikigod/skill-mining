import { test } from "node:test";
import assert from "node:assert/strict";
import { isScoreInflated, totalScore, enforceBuildCap, BUILD_CAP } from "../src/phases.js";
import { scoreDelta } from "../src/gates.js";

const scores = (n) => ({ freq: n, lev: n, bsp: n, stab: n, ver: n });

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

test("scoreDelta sums absolute axis differences", () => {
  assert.equal(scoreDelta(scores(5), scores(3)), 10);
  assert.equal(scoreDelta(scores(4), scores(4)), 0);
  assert.equal(scoreDelta({}, scores(2)), 10);
});
