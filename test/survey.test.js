import { test } from "node:test";
import assert from "node:assert/strict";
import { parseChurn, buildTreeSummary, buildExtHistogram, pickSampleFiles } from "../src/survey.js";

test("parseChurn counts every non-empty line as a file path", () => {
  const log = [
    "src/a.js",
    "",
    "src/a.js",
    "README",
    "",
    "Makefile",
    "src/deep/b file.ts",
  ].join("\n");
  const counts = parseChurn(log);
  assert.equal(counts["src/a.js"], 2);
  assert.equal(counts["README"], 1, "extensionless root files must not be dropped");
  assert.equal(counts["Makefile"], 1);
  assert.equal(counts["src/deep/b file.ts"], 1, "paths containing spaces must not be dropped");
});

test("buildTreeSummary groups by top-level dir with counts", () => {
  const summary = buildTreeSummary(["src/a.js", "src/b.js", "README.md", "test/x.js"]);
  assert.match(summary, /src\/ — 2 files/);
  assert.match(summary, /\(root\) — 1 file/);
  assert.match(summary, /test\/ — 1 file/);
});

test("buildExtHistogram counts extensions", () => {
  const hist = buildExtHistogram(["a.js", "b.js", "c.md", "Makefile"]);
  assert.match(hist, /\.js: 2/);
  assert.match(hist, /\.md: 1/);
  assert.match(hist, /\(no ext\): 1/);
});

test("pickSampleFiles prefers hotspots, adds entries and tests, caps at 12", () => {
  const paths = [
    "src/hot.js",
    "src/index.js",
    "src/other.rb",
    "test/hot.test.js",
    "docs/readme.md",
    ...Array.from({ length: 30 }, (_, i) => `src/f${i}.js`),
  ];
  const hotspots = [{ file: "src/hot.js", count: 9 }, { file: "missing.js", count: 5 }];
  const picked = pickSampleFiles(paths, hotspots);

  assert.ok(picked.includes("src/hot.js"), "hotspot file sampled");
  assert.ok(!picked.includes("missing.js"), "nonexistent hotspot skipped");
  assert.ok(picked.includes("src/index.js"), "entry point sampled");
  assert.ok(picked.includes("test/hot.test.js"), "test file sampled");
  assert.ok(!picked.includes("docs/readme.md"), "non-source files not sampled");
  assert.ok(picked.length <= 12, "cap respected");
});
