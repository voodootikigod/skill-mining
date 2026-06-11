import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanJsonResponse, resolveTierModel, buildCliArgv, assertSafeModelName } from "../src/llm.js";
import { parseArgs } from "../src/utils.js";

test("cleanJsonResponse extracts JSON from fenced/wrapped output", () => {
  assert.equal(cleanJsonResponse('Sure!\n```json\n{"a":1}\n```\nDone.'), '{"a":1}');
  assert.equal(cleanJsonResponse('{"a":1}'), '{"a":1}');
});

test("resolveTierModel picks tier with sensible fallbacks", () => {
  const config = { models: { strong: "sonnet", fast: "haiku", gate: null } };
  assert.equal(resolveTierModel(config, "strong"), "sonnet");
  assert.equal(resolveTierModel(config, "fast"), "haiku");
  assert.equal(resolveTierModel(config, "gate"), "sonnet", "gate falls back to strong");
  assert.equal(resolveTierModel({ models: { strong: "s", gate: "opus" } }, "gate"), "opus");
  assert.equal(resolveTierModel({ models: { strong: "s" } }, "fast"), "s", "fast falls back to strong");
  assert.equal(resolveTierModel({}, "strong"), null);
});

test("buildCliArgv returns argv arrays (no shell strings)", () => {
  assert.deepEqual(buildCliArgv("claude", "haiku"), ["claude", "-p", "--model", "haiku"]);
  assert.deepEqual(buildCliArgv("claude", null), ["claude", "-p"]);
  assert.deepEqual(buildCliArgv("codex", "o3"), ["codex", "exec", "-m", "o3"]);
  assert.deepEqual(buildCliArgv("agy", "x"), ["agy"], "unknown CLIs ignore model tier");
  // Pure function: even an odd value stays one inert argv element (never a
  // shell string). This call constructs an array; nothing is executed.
  const argv = buildCliArgv("claude", "weird value");
  assert.deepEqual(argv, ["claude", "-p", "--model", "weird value"]);
});

test("assertSafeModelName rejects shell metacharacters at config time", () => {
  assert.equal(assertSafeModelName("claude-sonnet-4-6", "--model"), "claude-sonnet-4-6");
  assert.equal(assertSafeModelName("us.anthropic.claude-v2:1", "--model"), "us.anthropic.claude-v2:1");
  assert.equal(assertSafeModelName(null, "--model"), null);
  for (const bad of ["sonnet; rm -rf /", "x && y", "a`b`", "$(cmd)", "has space", 'quo"te']) {
    assert.throws(() => assertSafeModelName(bad, "--model"), /Invalid model name/);
  }
});

test("parseArgs handles tier model flags in both forms", () => {
  const args = parseArgs([
    "node", "cli", "mine", ".",
    "--model-strong", "claude-sonnet-4-6",
    "--model-fast=claude-haiku-4-5",
    "--gate-model", "gpt-4o",
  ]);
  assert.equal(args.modelStrong, "claude-sonnet-4-6");
  assert.equal(args.modelFast, "claude-haiku-4-5");
  assert.equal(args.gateModel, "gpt-4o");
  assert.equal(args.target, ".");
});

test("parseArgs --model still sets the legacy single-model field", () => {
  const args = parseArgs(["node", "cli", "--model", "x"]);
  assert.equal(args.model, "x");
  assert.equal(args.modelStrong, null);
});
