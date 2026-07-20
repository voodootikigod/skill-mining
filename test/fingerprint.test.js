import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { generateSkillFingerprint, verifySkillFingerprint } from "../src/fingerprint.js";

async function makeSkillDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-fp-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, "SKILL.md"), "# Demo\n\nBody.\n");
  await fs.mkdir(path.join(dir, "references"));
  await fs.writeFile(path.join(dir, "references", "notes.md"), "notes\n");
  return dir;
}

test("generate + verify round-trips on a real directory", async (t) => {
  const dir = await makeSkillDir(t);
  const generated = await generateSkillFingerprint(dir, "demo-skill");

  assert.match(generated.fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(generated.files).sort(), ["SKILL.md", "references/notes.md"]);
  assert.match(generated.manifestText, /^# demo-skill — manifest @ /);
  assert.match(generated.manifestText, /SKILL\.md {3}sha256:[0-9a-f]{64}/);

  const verified = await verifySkillFingerprint(dir, "demo-skill", generated.fingerprint);
  assert.equal(verified.fingerprint, generated.fingerprint);
  assert.deepEqual(verified.files, generated.files);
});

test("fingerprint is stable across runs (timestamped manifest header excluded)", async (t) => {
  const dir = await makeSkillDir(t);
  const first = await generateSkillFingerprint(dir, "demo-skill");
  await new Promise(r => setTimeout(r, 5)); // force a different manifest timestamp
  const second = await generateSkillFingerprint(dir, "demo-skill");

  assert.equal(second.fingerprint, first.fingerprint);
  assert.deepEqual(second.files, first.files);
});

test("modifying a file is detected as a fingerprint mismatch", async (t) => {
  const dir = await makeSkillDir(t);
  const { fingerprint } = await generateSkillFingerprint(dir, "demo-skill");

  await fs.writeFile(path.join(dir, "SKILL.md"), "# Demo\n\nTampered body.\n");

  await assert.rejects(
    () => verifySkillFingerprint(dir, "demo-skill", fingerprint),
    /Fingerprint mismatch for skill "demo-skill"/
  );
});

test("adding a file also breaks the whole-directory fingerprint", async (t) => {
  const dir = await makeSkillDir(t);
  const { fingerprint } = await generateSkillFingerprint(dir, "demo-skill");

  await fs.writeFile(path.join(dir, "extra.md"), "smuggled\n");

  await assert.rejects(
    () => verifySkillFingerprint(dir, "demo-skill", fingerprint),
    /Fingerprint mismatch/
  );
});

test("empty directory fails verification with a clear error", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-fp-empty-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  await assert.rejects(
    () => verifySkillFingerprint(dir, "empty-skill", "sha256:whatever"),
    /empty or does not exist/
  );
});

test("missing directory fails verification with a clear error", async () => {
  const missing = path.join(os.tmpdir(), "skill-fp-does-not-exist", "nope");
  await assert.rejects(
    () => verifySkillFingerprint(missing, "ghost-skill", "sha256:whatever"),
    /empty or does not exist/
  );
});
