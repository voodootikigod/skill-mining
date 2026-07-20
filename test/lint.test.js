import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter, lintSkillArtifact, lintSkillSet, lintAgentArtifact } from "../src/lint.js";

const GOOD_SKILL = `---
name: run-tests-here
description: >-
  Use when running tests in this repo — node --test against test/, no build step.
license: MIT
user-invocable: true
metadata:
  version: 1.0.0
---

# Run Tests Here

This skill explains exactly how tests run in this repository so an agent does not
re-derive the invocation on every task.

## When to use

- Running or adding tests.

## The procedure

1. Run \`node --test test/\` from the repo root.

## Verification

Run \`node --test test/\` — exit code 0 and all tests reported as passing.
`;

test("parseFrontmatter parses plain and folded values", () => {
  const fm = parseFrontmatter(GOOD_SKILL);
  assert.equal(fm.ok, true);
  assert.equal(fm.data.name, "run-tests-here");
  assert.match(fm.data.description, /Use when running tests/);
  assert.match(fm.body, /## Verification/);
});

test("parseFrontmatter rejects missing/unclosed frontmatter", () => {
  assert.equal(parseFrontmatter("# no frontmatter").ok, false);
  assert.equal(parseFrontmatter("---\nname: x\n# never closed").ok, false);
});

test("lintSkillArtifact passes a well-formed skill", () => {
  const errors = lintSkillArtifact({ name: "run-tests-here", markdown: GOOD_SKILL });
  assert.deepEqual(errors, []);
});

test("lintSkillArtifact catches name mismatch, bad kebab, missing verification, dangling refs", () => {
  const bad = GOOD_SKILL
    .replace("name: run-tests-here", "name: Run_Tests")
    .replace("## Verification", "## Checking")
    + "\nSee references/missing-checklist.md for details.\n";
  const errors = lintSkillArtifact({ name: "run-tests-here", markdown: bad });

  assert.ok(errors.some(e => e.includes("kebab-case")));
  assert.ok(errors.some(e => e.includes("does not match")));
  assert.ok(errors.some(e => e.includes("Verification")));
  assert.ok(errors.some(e => e.includes("dangling reference")));
});

test("lintSkillArtifact requires a trigger-rich description", () => {
  const bad = GOOD_SKILL.replace(/description: >-\n.*\n/, "description: short\n");
  const errors = lintSkillArtifact({ name: "run-tests-here", markdown: bad });
  assert.ok(errors.some(e => e.includes("description")));
});

test("lintSkillArtifact rejects a long description with no trigger phrase", () => {
  const bad = GOOD_SKILL.replace(
    /description: >-\n.*\n/,
    "description: A document about the testing conventions of this repository, in detail.\n"
  );
  const errors = lintSkillArtifact({ name: "run-tests-here", markdown: bad });
  assert.ok(errors.some(e => e.includes("description lacks a trigger phrase")));
});

test("lintSkillArtifact accepts each recognized trigger phrase form", () => {
  const phrases = [
    "Use when running tests in this repo, from the repo root.",
    "Use for running the integration test suite in this repo.",
    "Load this when you need to run the test suite locally.",
    "Triggers on requests to run or debug the test suite here.",
  ];
  for (const desc of phrases) {
    const md = GOOD_SKILL.replace(/description: >-\n.*\n/, `description: ${desc}\n`);
    const errors = lintSkillArtifact({ name: "run-tests-here", markdown: md });
    assert.ok(!errors.some(e => e.includes("trigger phrase")), `rejected: "${desc}"`);
  }
});

test("the skill template's own description style passes the trigger-phrase lint", async () => {
  const fs = await import("fs/promises");
  const template = await fs.readFile(
    new URL("../skill-mining/references/templates/skill-template.md", import.meta.url),
    "utf8"
  );
  const fm = parseFrontmatter(template);
  assert.equal(fm.ok, true);
  // The template is placeholder-ridden (name, etc.) — only assert that its
  // documented description style would not trip the trigger-phrase check.
  const errors = lintSkillArtifact({ markdown: template });
  assert.ok(!errors.some(e => e.includes("trigger phrase")));
});

test("lintSkillSet flags duplicate names", () => {
  const errors = lintSkillSet([{ name: "a" }, { name: "b" }, { name: "a" }]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /duplicate/);
});

test("lintAgentArtifact validates frontmatter basics", () => {
  const agent = `---\nname: reviewer\ndescription: Reviews diffs using mined convention skills.\n---\n\n# Reviewer\n`;
  assert.deepEqual(lintAgentArtifact({ name: "reviewer", markdown: agent }), []);
  assert.ok(lintAgentArtifact({ name: "other", markdown: agent }).some(e => e.includes("does not match")));
});
