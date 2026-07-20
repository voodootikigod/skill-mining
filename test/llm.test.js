import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanJsonResponse, resolveTierModel, buildCliArgv, assertSafeModelName,
  isTruncated, openAiTokenParam, llmCall, llmCallJson, configureLLM,
} from "../src/llm.js";
import { parseArgs } from "../src/utils.js";

// Minimal fetch Response stand-in for stubbing globalThis.fetch.
const jsonRes = (obj) => ({
  ok: true,
  status: 200,
  json: async () => obj,
  text: async () => JSON.stringify(obj),
});

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

test("isTruncated detects each provider's finish reason", () => {
  assert.equal(isTruncated("anthropic", { stop_reason: "max_tokens" }), true);
  assert.equal(isTruncated("anthropic", { stop_reason: "end_turn" }), false);
  assert.equal(isTruncated("openai", { choices: [{ finish_reason: "length" }] }), true);
  assert.equal(isTruncated("openai", { choices: [{ finish_reason: "stop" }] }), false);
  assert.equal(isTruncated("gemini", { candidates: [{ finishReason: "MAX_TOKENS" }] }), true);
  assert.equal(isTruncated("gemini", { candidates: [{ finishReason: "STOP" }] }), false);
  // Malformed payloads must not crash detection
  assert.equal(isTruncated("openai", {}), false);
  assert.equal(isTruncated("gemini", null), false);
  assert.equal(isTruncated("unknown", { stop_reason: "max_tokens" }), false);
});

test("openAiTokenParam routes new model families to max_completion_tokens", () => {
  assert.equal(openAiTokenParam("gpt-5"), "max_completion_tokens");
  assert.equal(openAiTokenParam("gpt-5-mini"), "max_completion_tokens");
  assert.equal(openAiTokenParam("o3"), "max_completion_tokens");
  assert.equal(openAiTokenParam("o1-mini"), "max_completion_tokens");
  assert.equal(openAiTokenParam("gpt-4o"), "max_tokens");
  assert.equal(openAiTokenParam("gpt-4o-mini"), "max_tokens");
  assert.equal(openAiTokenParam(null), "max_tokens");
});

test("configureLLM openai defaults resolve to the gpt-5 tiers", () => {
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  try {
    const config = configureLLM(parseArgs(["node", "cli", "mine", ".", "--provider", "openai"]));
    assert.equal(config.models.strong, "gpt-5");
    assert.equal(config.models.fast, "gpt-5-mini");
  } finally {
    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
  }
});

test("llmCall delegates to config.caller (C4 test seam)", async () => {
  const calls = [];
  const config = {
    provider: "anthropic",
    caller: async (_cfg, prompt, systemInstruction, jsonMode, tier) => {
      calls.push({ prompt, systemInstruction, jsonMode, tier });
      return '{"ok":true}';
    },
  };
  const out = await llmCall(config, "hello", "sysmsg", true, "fast");
  assert.equal(out, '{"ok":true}');
  assert.deepEqual(calls[0], { prompt: "hello", systemInstruction: "sysmsg", jsonMode: true, tier: "fast" });

  // llmCallJson rides the same seam
  const parsed = await llmCallJson(config, "p", "s", "gate", "seam test");
  assert.deepEqual(parsed, { ok: true });
});

test("llmCall throws a truncation error for each API provider", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("anthropic")) return jsonRes({ stop_reason: "max_tokens", content: [{ type: "text", text: "half" }] });
    if (u.includes("openai")) return jsonRes({ choices: [{ finish_reason: "length", message: { content: "half" } }] });
    return jsonRes({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "half" }] } }] });
  };
  try {
    // Concurrent on purpose: each call walks the full retry/backoff loop.
    const results = await Promise.allSettled([
      llmCall({ provider: "anthropic", apiKey: "k", models: { strong: "m" } }, "p"),
      llmCall({ provider: "openai", apiKey: "k", models: { strong: "gpt-4o" } }, "p"),
      llmCall({ provider: "gemini", apiKey: "k", models: { strong: "m" } }, "p"),
    ]);
    for (const r of results) {
      assert.equal(r.status, "rejected", "truncated response must throw, never return partial text");
      assert.match(r.reason.message, /truncated at \d+ output tokens/);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Anthropic parsing picks the first text block, not content[0]", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonRes({
    stop_reason: "end_turn",
    content: [{ type: "thinking", thinking: "…" }, { type: "text", text: "answer" }],
  });
  try {
    const out = await llmCall({ provider: "anthropic", apiKey: "k", models: { strong: "m" } }, "p");
    assert.equal(out, "answer");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("OpenAI 400 mentioning max_tokens retries once with max_completion_tokens", async () => {
  const realFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    if (bodies.length === 1) {
      return { ok: false, status: 400, text: async () => "Unsupported parameter: 'max_tokens' is not supported with this model." };
    }
    return jsonRes({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] });
  };
  try {
    const out = await llmCall({ provider: "openai", apiKey: "k", models: { strong: "gpt-4o" } }, "p");
    assert.equal(out, "ok");
    assert.ok("max_tokens" in bodies[0], "first attempt uses the legacy param for gpt-4o");
    assert.ok("max_completion_tokens" in bodies[1] && !("max_tokens" in bodies[1]), "retry swaps the param");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("gpt-5 family requests send max_completion_tokens up front", async () => {
  const realFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return jsonRes({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] });
  };
  try {
    await llmCall({ provider: "openai", apiKey: "k", models: { strong: "gpt-5" } }, "p");
    assert.equal(bodies.length, 1, "no param-swap retry needed");
    assert.ok("max_completion_tokens" in bodies[0] && !("max_tokens" in bodies[0]));
  } finally {
    globalThis.fetch = realFetch;
  }
});
