import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPathTokens, verifyCandidateEvidence } from "../src/evidence.js";

test("extractPathTokens finds paths, skips URLs/SHAs/globs/version pins", () => {
  const tokens = extractPathTokens(
    "See src/llm.js and bin/cli.js, commit 9ff7b232c7122027ef540c2b766932390fed0469, " +
    "https://github.com/u/r/blob/main/x.js, pattern src/*.js, pkg lodash@4.17.21, package.json."
  );
  assert.ok(tokens.includes("src/llm.js"));
  assert.ok(tokens.includes("bin/cli.js"));
  assert.ok(tokens.includes("package.json"));
  assert.ok(!tokens.some(t => t.includes("github.com")), "URLs excluded");
  assert.ok(!tokens.some(t => /^[0-9a-f]{40}$/.test(t)), "SHAs excluded");
  assert.ok(!tokens.some(t => t.includes("*")), "globs excluded");
});

test("extractPathTokens drops glob tokens whole — no fragment re-matching", () => {
  // "src/**" being consumed as one (filtered) token must not let the regex
  // re-match the leftover "*.test.js" as a clean-looking "test.js".
  assert.deepEqual(extractPathTokens("Test files match src/**/*.test.js"), []);
  // Markdown emphasis around a real path is unwrapped, not dropped
  assert.deepEqual(extractPathTokens("See **src/app.js** for details."), ["src/app.js"]);
});

test("verifyCandidateEvidence flags fabricated and unverifiable evidence", () => {
  const allPaths = ["src/llm.js", "src/phases.js", "bin/cli.js"];
  const candidates = [
    { name: "real", evidence: "Pattern lives in src/llm.js and bin/cli.js", example: "" },
    { name: "fabricated", evidence: "Defined in src/nonexistent.js", example: "" },
    { name: "dir-cite", evidence: "All files under src/ follow this", example: "src/phases.js" },
    { name: "vague", evidence: "The team always does this", example: "run the tests" },
  ];

  const out = verifyCandidateEvidence(candidates, allPaths);
  const byName = Object.fromEntries(out.map(c => [c.name, c]));

  assert.equal(byName.real.evidenceVerified, true);
  assert.equal(byName.fabricated.evidenceVerified, false);
  assert.match(byName.fabricated.evidenceNotes, /not found/);
  assert.equal(byName["dir-cite"].evidenceVerified, true, "directory prefixes count as existing");
  assert.equal(byName.vague.evidenceVerified, false);
  assert.match(byName.vague.evidenceNotes, /no checkable/);
});

test("verifyCandidateEvidence does not mutate input candidates", () => {
  const cand = { name: "x", evidence: "src/llm.js" };
  verifyCandidateEvidence([cand], ["src/llm.js"]);
  assert.equal(cand.evidenceVerified, undefined);
});
