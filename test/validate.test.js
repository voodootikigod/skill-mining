import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, execFile } from "node:child_process";
import {
  generateDiff,
  extractProvenance,
  computeLocalSourcesHash,
  checkCache,
  writeCache,
  getLocalSkills,
  normalizeFlags,
  getRelativeFilesRecursive
} from "../src/validate.js";

// Helper to compute sha256
function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

test("generateDiff produces correct unified line-based diff", () => {
  const oldText = "line 1\nline 2\nline 3";
  const newText = "line 1\nline 2 modified\nline 3\nline 4";
  const expected = "- line 2\n+ line 2 modified\n+ line 4";
  const actual = generateDiff(oldText, newText);
  assert.equal(actual, expected);
});

test("extractProvenance parses nested block YAML correctly", () => {
  const md = `---
name: test-skill
provenance:
  clusterSize: 5
  evidence:
    - "found inside test file line 12"
    - "found inside another file line 45"
---`;
  const prov = extractProvenance(md);
  assert.ok(prov);
  assert.equal(prov.clusterSize, 5);
  assert.deepEqual(prov.evidence, [
    "found inside test file line 12",
    "found inside another file line 45"
  ]);
});

test("extractProvenance parses flat frontmatter keys correctly", () => {
  const md = `---
name: test-skill
provenance_cluster_size: 3
provenance_evidence: "found in file.js line 5"
---`;
  const prov = extractProvenance(md);
  assert.ok(prov);
  assert.equal(prov.clusterSize, 3);
  assert.deepEqual(prov.evidence, ["found in file.js line 5"]);
});

test("extractProvenance returns null when no provenance is present", () => {
  const md = `---
name: test-skill
description: Use when building test suites
---`;
  const prov = extractProvenance(md);
  assert.equal(prov, null);
});

test("computeLocalSourcesHash is deterministic and matches sorted input", () => {
  const sources = [
    { name: "b-skill", description: "desc B", path: "/path/b" },
    { name: "a-skill", description: "desc A", path: "/path/a" }
  ];
  const hash1 = computeLocalSourcesHash(sources);
  const hash2 = computeLocalSourcesHash([sources[1], sources[0]]);
  assert.equal(hash1, hash2);
});

test("cache ledger writes and reads clean hits, and invalidates on changes", async () => {
  const tempDir = path.join(path.resolve("."), "test-temp-cache");
  await fs.mkdir(tempDir, { recursive: true });
  const cacheFile = path.join(tempDir, "test-cache.json");

  try {
    const contentHash = sha256("my raw content");
    const localSourcesHash = sha256("my local sources");
    const registry = "skills.sh";
    const registryContentHash = sha256("my registry content");
    const flags = { offline: false, refine: true };
    const verdictJson = { verdict: "SHIP", exitCode: 0 };

    // Write to cache
    await writeCache(cacheFile, contentHash, localSourcesHash, registry, flags, registryContentHash, "", verdictJson);

    // Clean cache hit
    const hit = await checkCache(cacheFile, contentHash, localSourcesHash, registry, flags, registryContentHash, "");
    assert.deepEqual(hit, verdictJson);

    // Invalidate on content change
    const missContent = await checkCache(cacheFile, sha256("different content"), localSourcesHash, registry, flags, registryContentHash, "");
    assert.equal(missContent, null);

    // Invalidate on local sources change
    const missSources = await checkCache(cacheFile, contentHash, sha256("different sources"), registry, flags, registryContentHash, "");
    assert.equal(missSources, null);

    // Invalidate on registry change
    const missRegistry = await checkCache(cacheFile, contentHash, localSourcesHash, "different.sh", flags, registryContentHash, "");
    assert.equal(missRegistry, null);

    // Invalidate on registry content change
    const missRegistryContent = await checkCache(cacheFile, contentHash, localSourcesHash, registry, flags, sha256("different registry content"), "");
    assert.equal(missRegistryContent, null);

    // Invalidate on flags change
    const missFlags = await checkCache(cacheFile, contentHash, localSourcesHash, registry, { offline: true, refine: true }, registryContentHash, "");
    assert.equal(missFlags, null);

  } finally {
    // Cleanup
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (e) {}
  }
});

test("getLocalSkills scans and parses local stubs, excluding the target path", async () => {
  const tempDir = path.join(path.resolve("."), "test-temp-skills");
  const lessonsDir = path.join(tempDir, ".adlc", "lessons");
  const skillsDir = path.join(tempDir, ".agents", "skills");

  await fs.mkdir(lessonsDir, { recursive: true });
  await fs.mkdir(skillsDir, { recursive: true });

  const stub1 = path.join(lessonsDir, "stub-1.SKILL.md");
  const stub2 = path.join(lessonsDir, "stub-2.SKILL.md");
  const stub3 = path.join(skillsDir, "installed-1", "SKILL.md");

  await fs.mkdir(path.dirname(stub3), { recursive: true });

  await fs.writeFile(stub1, "---\nname: stub-1\ndescription: Use when stub 1\n---\nbody 1", "utf8");
  await fs.writeFile(stub2, "---\nname: stub-2\ndescription: Use when stub 2\n---\nbody 2", "utf8");
  await fs.writeFile(stub3, "---\nname: installed-1\ndescription: Use when installed 1\n---\nbody 3", "utf8");

  try {
    // Scan dirs, excluding stub1
    const local = await getLocalSkills([lessonsDir, skillsDir], stub1);

    // Should contain stub-2 and installed-1, but not stub-1
    assert.equal(local.length, 2);
    const names = local.map(s => s.name).sort();
    assert.deepEqual(names, ["installed-1", "stub-2"]);
  } finally {
    // Cleanup
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (e) {}
  }
});

test("normalizeFlags sorts arrays and returns sorted keys in deterministic order", () => {
  const flags1 = { refine: true, alsoLocal: ["b", "a"] };
  const flags2 = { alsoLocal: ["a", "b"], refine: true };
  const norm1 = normalizeFlags(flags1);
  const norm2 = normalizeFlags(flags2);
  assert.deepEqual(norm1, norm2);
  assert.deepEqual(Object.keys(norm1), ["alsoLocal", "refine"]);
  assert.deepEqual(norm1.alsoLocal, ["a", "b"]);
});

test("CLI validate: rejects invalid frontmatter with exit code 2", async () => {
  const tempSkillFile = path.resolve("./test-invalid-fm.SKILL.md");
  await fs.writeFile(tempSkillFile, "---\ninvalid_frontmatter\n---\nbody", "utf8");
  try {
    execFileSync("node", ["bin/cli.js", "validate", tempSkillFile, "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8"
    });
    assert.fail("Should have exited with code 2");
  } catch (err) {
    assert.equal(err.status, 2);
    const parsed = JSON.parse(err.stdout);
    assert.equal(parsed.verdict, "REJECT");
    assert.match(parsed.notes, /frontmatter/i);
  } finally {
    await fs.unlink(tempSkillFile).catch(() => {});
  }
});

test("CLI validate: rejects non-kebab-case name with exit code 2", async () => {
  const tempSkillFile = path.resolve("./test-non-kebab.SKILL.md");
  await fs.writeFile(tempSkillFile, "---\nname: InvalidNameHere\ndescription: Some desc\n---\nbody", "utf8");
  try {
    execFileSync("node", ["bin/cli.js", "validate", tempSkillFile, "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8"
    });
    assert.fail("Should have exited with code 2");
  } catch (err) {
    assert.equal(err.status, 2);
    const parsed = JSON.parse(err.stdout);
    assert.equal(parsed.verdict, "REJECT");
    assert.match(parsed.notes, /kebab-case/i);
  } finally {
    await fs.unlink(tempSkillFile).catch(() => {});
  }
});

test("CLI validate: prompt-only state file resume and validation", async () => {
  const tempSkillFile = path.resolve("./test-prompt-resume.SKILL.md");
  await fs.writeFile(tempSkillFile, "---\nname: test-prompt-resume\ndescription: Some trigger-rich description of at least twenty characters.\n---\nThis is a long body of at least one hundred characters to pass the new validation lint conventions. We must keep adding text here to reach the threshold.\n\n## Verification\nRun tests.", "utf8");
  
  const pathHash = crypto.createHash("sha256").update(tempSkillFile).digest("hex");
  const stateFile = path.resolve(`.agents/validate-state-${pathHash}.json`);
  const cacheFile = path.resolve(`.agents/validate-cache-${pathHash}.json`);

  try {
    await fs.unlink(stateFile).catch(() => {});
    await fs.unlink(cacheFile).catch(() => {});

    // First run: starts in 'init', outputs scoring prompt, exits 1
    try {
      execFileSync("node", ["bin/cli.js", "validate", tempSkillFile, "--prompt-only", "--json"], {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8"
      });
      assert.fail("Should have exited with code 1");
    } catch (err) {
      assert.equal(err.status, 1);
      const parsed = JSON.parse(err.stdout);
      assert.equal(parsed.verdict, "INCOMPLETE");
      assert.equal(parsed.complete, false);
      assert.match(parsed.prompt, /evaluate the following skill/i);
    }

    // Verify state file exists and step is 'scoring'
    const stateContent = JSON.parse(await fs.readFile(stateFile, "utf8"));
    assert.equal(stateContent.step, "scoring");

    // Second run: pipe scoring response to resume
    const scoringResponse = JSON.stringify({
      scores: { freq: 4, lev: 4, bsp: 4, stab: 4, ver: 4 },
      rationale: "Excellent scoring"
    });

    try {
      execFileSync("node", ["bin/cli.js", "validate", tempSkillFile, "--prompt-only", "--json"], {
        input: scoringResponse,
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf8"
      });
      assert.fail("Should have exited with code 1");
    } catch (err) {
      assert.equal(err.status, 1);
      const parsed = JSON.parse(err.stdout);
      assert.equal(parsed.verdict, "INCOMPLETE");
      assert.equal(parsed.complete, false);
      assert.match(parsed.prompt, /deduplication decision/i);
    }

    // Verify state file updated to 'dedupe'
    const stateContent2 = JSON.parse(await fs.readFile(stateFile, "utf8"));
    assert.equal(stateContent2.step, "dedupe");
    assert.equal(stateContent2.scoring.frequency, 4);

  } finally {
    await fs.unlink(tempSkillFile).catch(() => {});
    await fs.unlink(stateFile).catch(() => {});
    await fs.unlink(cacheFile).catch(() => {});
  }
});

test("CLI validate: dedupe REUSE skips Gate B and rolls up to REUSE with exit code 2", async () => {
  const tempSkillFile = path.resolve("./test-reuse-skip.SKILL.md");
  await fs.writeFile(tempSkillFile, "---\nname: test-reuse-skip\ndescription: Some trigger-rich description of at least twenty characters.\n---\nThis is a long body of at least one hundred characters to pass the new validation lint conventions. We must keep adding text here to reach the threshold.\n\n## Verification\nRun tests.", "utf8");
  
  const pathHash = crypto.createHash("sha256").update(tempSkillFile).digest("hex");
  const stateFile = path.resolve(`.agents/validate-state-${pathHash}.json`);
  const cacheFile = path.resolve(`.agents/validate-cache-${pathHash}.json`);

  try {
    await fs.unlink(stateFile).catch(() => {});
    await fs.unlink(cacheFile).catch(() => {});

    try {
      execFileSync("node", ["bin/cli.js", "validate", tempSkillFile, "--prompt-only", "--json"], {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8"
      });
    } catch (e) {}

    try {
      execFileSync("node", ["bin/cli.js", "validate", tempSkillFile, "--prompt-only", "--json"], {
        input: JSON.stringify({ scores: { freq: 3, lev: 3, bsp: 3, stab: 3, ver: 3 }, rationale: "ok" }),
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf8"
      });
    } catch (e) {}

    try {
      execFileSync("node", ["bin/cli.js", "validate", tempSkillFile, "--prompt-only", "--json"], {
        input: JSON.stringify({ finalDecision: "REUSE", source: "community/some-source-skill", justification: "already exists", match: "community/some-source-skill" }),
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf8"
      });
      assert.fail("Should have exited with code 2");
    } catch (err) {
      assert.equal(err.status, 2);
      const parsed = JSON.parse(err.stdout);
      assert.equal(parsed.verdict, "REUSE");
      assert.equal(parsed.complete, true);
      assert.equal(parsed.gateB.evidence, "Gate B skipped because deduplication decision was REUSE.");
      
      await assert.rejects(fs.access(stateFile));
      await assert.doesNotReject(fs.access(cacheFile));
    }

  } finally {
    await fs.unlink(tempSkillFile).catch(() => {});
    await fs.unlink(stateFile).catch(() => {});
    await fs.unlink(cacheFile).catch(() => {});
  }
});

test("getRelativeFilesRecursive scans directory recursively and returns relative paths", async () => {
  const tempDir = path.resolve("./test-temp-recursive-files");
  await fs.mkdir(path.join(tempDir, "references", "sub"), { recursive: true });
  await fs.writeFile(path.join(tempDir, "SKILL.md"), "content 1", "utf8");
  await fs.writeFile(path.join(tempDir, "references", "ref1.md"), "content 2", "utf8");
  await fs.writeFile(path.join(tempDir, "references", "sub", "ref2.md"), "content 3", "utf8");

  try {
    const files = await getRelativeFilesRecursive(tempDir);
    const sorted = [...files].sort();
    assert.deepEqual(sorted, [
      "SKILL.md",
      "references/ref1.md",
      "references/sub/ref2.md"
    ]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("CLI validate: fails on unknown CLI flags with descriptive error", async () => {
  try {
    execFileSync("node", ["bin/cli.js", "validate", "some-path", "--unknown-flag-xyz"], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8"
    });
    assert.fail("Should have failed on unknown CLI option");
  } catch (err) {
    assert.ok(err.stderr.includes("Unknown option") || err.stdout.includes("Unknown option") || err.message.includes("Unknown option"));
  }
});

test("getLocalSkills recursive traversal", async () => {
  const tempDir = path.resolve("./test-temp-local-skills-rec");
  await fs.mkdir(path.join(tempDir, "subdir1/subdir2"), { recursive: true });
  
  await fs.writeFile(path.join(tempDir, "skill1.SKILL.md"), "---\nname: skill1\ndescription: test description\n---\nbody", "utf8");
  await fs.writeFile(path.join(tempDir, "subdir1/skill2.SKILL.md"), "---\nname: skill2\ndescription: test description 2\n---\nbody", "utf8");
  await fs.writeFile(path.join(tempDir, "subdir1/subdir2/SKILL.md"), "---\nname: skill3\ndescription: test description 3\n---\nbody", "utf8");

  try {
    const skills = await getLocalSkills([tempDir], "nonexistent");
    const names = skills.map(s => s.name).sort();
    assert.deepEqual(names, ["skill1", "skill2", "skill3"]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("extractProvenance flat evidence match restriction", () => {
  // Should NOT match plain 'evidence' key
  const noProv = extractProvenance(`---
provenance_cluster_size: 3
evidence: "this is some plain evidence"
---
body`);
  assert.deepEqual(noProv, { clusterSize: 3, evidence: [] });

  // Should match provenance_evidence or provenance-evidence keys
  const provWithEvidence = extractProvenance(`---
provenance_cluster_size: 3
provenance_evidence: "this is actual provenance evidence"
---
body`);
  assert.deepEqual(provWithEvidence, {
    clusterSize: 3,
    evidence: ["this is actual provenance evidence"]
  });
});

test("CLI validate path traversal rejection in references", async () => {
  const tempSkillFile = path.resolve("./test-traversal.SKILL.md");
  await fs.writeFile(tempSkillFile, `---\nname: test-traversal\ndescription: Some trigger-rich description of at least twenty characters.\n---\nThis is a long body of at least one hundred characters to pass the new validation lint conventions.\nreferences/../../outside-file\n\n## Verification\nRun tests.`, "utf8");

  try {
    execFileSync("node", ["bin/cli.js", "validate", tempSkillFile, "--prompt-only"], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8"
    });
    assert.fail("Should have failed due to path traversal");
  } catch (err) {
    assert.equal(err.status, 3);
    assert.ok(err.stderr.includes("Path traversal detected") || err.stdout.includes("Path traversal detected"));
  } finally {
    await fs.unlink(tempSkillFile).catch(() => {});
  }
});
test("generateDiff correctly handles repeated lines", () => {
  const oldText = "A\nB\nA\nC";
  const newText = "A\nA\nB\nC";
  const actual = generateDiff(oldText, newText);
  assert.equal(actual, "- B\n+ B");
});

test("checkCache validation rejects forged/malicious inputs", async () => {
  const tempDir = path.join(path.resolve("."), "test-temp-cache-forged");
  await fs.mkdir(tempDir, { recursive: true });
  const cacheFile = path.join(tempDir, "test-cache.json");

  try {
    const contentHash = sha256("my raw content");
    const localSourcesHash = sha256("my local sources");
    const registry = "skills.sh";
    const registryContentHash = sha256("my registry content");
    const flags = { offline: false };

    // Malicious cache data: exitCode is out of range
    const maliciousVerdict1 = { verdict: "SHIP", exitCode: 5 };
    await writeCache(cacheFile, contentHash, localSourcesHash, registry, flags, registryContentHash, "", maliciousVerdict1);
    const hit1 = await checkCache(cacheFile, contentHash, localSourcesHash, registry, flags, registryContentHash, "");
    assert.equal(hit1, null);

    // Malicious cache data: verdict is not in enum
    const maliciousVerdict2 = { verdict: "MALICIOUS", exitCode: 0 };
    await writeCache(cacheFile, contentHash, localSourcesHash, registry, flags, registryContentHash, "", maliciousVerdict2);
    const hit2 = await checkCache(cacheFile, contentHash, localSourcesHash, registry, flags, registryContentHash, "");
    assert.equal(hit2, null);

  } finally {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (e) {}
  }
});

test("Containment checks enforce sibling directory boundary", async () => {
  const tempBase = path.resolve("./test-temp-containment-base");
  const tempSibling = path.resolve("./test-temp-containment-base-sibling");
  
  await fs.mkdir(tempBase, { recursive: true });
  await fs.mkdir(tempSibling, { recursive: true });

  try {
    const symInBase = path.join(tempBase, "symlink-file");
    const targetFile = path.join(tempSibling, "target-file.txt");
    await fs.writeFile(targetFile, "secret content", "utf8");
    await fs.symlink(targetFile, symInBase);

    const files = await getRelativeFilesRecursive(tempBase);
    assert.equal(files.length, 0);
  } finally {
    await fs.rm(tempBase, { recursive: true, force: true }).catch(() => {});
    await fs.rm(tempSibling, { recursive: true, force: true }).catch(() => {});
  }
});

test("CLI validate: prompt-only multiround Gate B FIX and SHIP refinement flow", async () => {
  const tempSkillFile = path.resolve("./test-prompt-gateb-flow.SKILL.md");
  await fs.writeFile(tempSkillFile, "---\nname: test-prompt-gateb-flow\ndescription: Some trigger-rich description of at least twenty characters.\n---\nThis is a long body of at least one hundred characters to pass the new validation lint conventions. We must keep adding text here to reach the threshold.\n\n## Verification\nRun tests.", "utf8");
  
  const pathHash = crypto.createHash("sha256").update(tempSkillFile).digest("hex");
  const stateFile = path.resolve(`.agents/validate-state-${pathHash}.json`);
  const cacheFile = path.resolve(`.agents/validate-cache-${pathHash}.json`);

  try {
    await fs.unlink(stateFile).catch(() => {});
    await fs.unlink(cacheFile).catch(() => {});

    // 1. Init run -> Scoring prompt
    try {
      execFileSync("node", ["bin/cli.js", "validate", tempSkillFile, "--prompt-only", "--json", "--refine"], {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8"
      });
    } catch (err) {
      assert.equal(err.status, 1);
    }

    // 2. Resume with Scoring response -> Dedupe prompt
    try {
      execFileSync("node", ["bin/cli.js", "validate", tempSkillFile, "--prompt-only", "--json", "--refine"], {
        input: JSON.stringify({ scores: { freq: 4, lev: 4, bsp: 4, stab: 4, ver: 4 }, rationale: "ok" }),
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf8"
      });
    } catch (err) {
      assert.equal(err.status, 1);
    }

    // 3. Resume with Dedupe response -> Synthetic task prompt
    try {
      execFileSync("node", ["bin/cli.js", "validate", tempSkillFile, "--prompt-only", "--json", "--refine"], {
        input: JSON.stringify({ finalDecision: "BUILD", match: null, justification: "unique skill" }),
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf8"
      });
    } catch (err) {
      assert.equal(err.status, 1);
    }

    // 4. Resume with Synthetic task -> Gate B review prompt
    try {
      execFileSync("node", ["bin/cli.js", "validate", tempSkillFile, "--prompt-only", "--json", "--refine"], {
        input: "Run unit tests for prompt-only resume flow.",
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf8"
      });
    } catch (err) {
      assert.equal(err.status, 1);
      const parsed = JSON.parse(err.stdout);
      assert.match(parsed.prompt, /Adversarial Review Guidelines/i);
    }

    // 5. Resume with Gate B FIX review -> Gate B fix prompt
    try {
      execFileSync("node", ["bin/cli.js", "validate", tempSkillFile, "--prompt-only", "--json", "--refine"], {
        input: JSON.stringify({ verdict: "FIX", objections: ["Missing exit codes section"], requestedEdits: "Add exit codes." }),
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf8"
      });
    } catch (err) {
      assert.equal(err.status, 1);
      const parsed = JSON.parse(err.stdout);
      assert.match(parsed.prompt, /Apply the fixes/i);
    }

    // 6. Resume with Gate B fixed content -> Gate B review prompt (round 2)
    const fixedContent = "---\nname: test-prompt-gateb-flow\ndescription: Some trigger-rich description of at least twenty characters.\n---\nThis is a long body of at least one hundred characters to pass the new validation lint conventions. With exit codes.\n\n## Verification\nRun tests.";
    try {
      execFileSync("node", ["bin/cli.js", "validate", tempSkillFile, "--prompt-only", "--json", "--refine"], {
        input: fixedContent,
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf8"
      });
    } catch (err) {
      assert.equal(err.status, 1);
      const parsed = JSON.parse(err.stdout);
      assert.match(parsed.prompt, /Refined Round 1/i);
    }

    // 7. Resume with Gate B SHIP review -> Completed SHIP!
    try {
      execFileSync("node", ["bin/cli.js", "validate", tempSkillFile, "--prompt-only", "--json", "--refine"], {
        input: JSON.stringify({ verdict: "SHIP", objections: [], requestedEdits: "" }),
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf8"
      });
      assert.fail("Should have exited with status 2 due to proposed refinements in headless mode");
    } catch (err) {
      assert.equal(err.status, 2);
      const parsed = JSON.parse(err.stdout);
      assert.equal(parsed.verdict, "FIX");
      assert.equal(parsed.complete, true);
      assert.equal(parsed.exitCode, 2);
      assert.match(parsed.diff, /With exit codes/);
    }

  } finally {
    await fs.unlink(tempSkillFile).catch(() => {});
    await fs.unlink(stateFile).catch(() => {});
    await fs.unlink(cacheFile).catch(() => {});
  }
});

test("checkCache / refine: headless cache write preserves proposed refinements and interactive re-run prompts for approval", async () => {
  const tempSkillFile = path.resolve("./test-refine-headless.SKILL.md");
  const originalMarkdown = "---\nname: test-refine-headless\ndescription: Some trigger-rich description of at least twenty characters.\n---\nThis is a long body of at least one hundred characters to pass the new validation lint conventions. We must keep adding text here to reach the threshold.\n\n## Verification\nRun tests.";
  await fs.writeFile(tempSkillFile, originalMarkdown, "utf8");

  const pathHash = crypto.createHash("sha256").update(tempSkillFile).digest("hex");
  const cacheFile = path.resolve(`.agents/validate-cache-${pathHash}.json`);

  try {
    await fs.unlink(cacheFile).catch(() => {});

    // Write a mock cache entry simulating a headless refinement proposal
    const contentHash = crypto.createHash("sha256").update(originalMarkdown + "\n").digest("hex");
    const targetDir = path.dirname(tempSkillFile);
    const projectRoot = path.resolve(".");
    const defaultLocalDirs = [
      path.join(targetDir, ".adlc", "lessons"),
      path.join(projectRoot, ".adlc", "lessons"),
      path.join(projectRoot, ".agents", "skills")
    ];
    const scanDirs = [...new Set(defaultLocalDirs.map(d => path.resolve(d)))];
    const localSkills = await getLocalSkills(scanDirs, tempSkillFile);
    const localSourcesHash = computeLocalSourcesHash(localSkills);

    let gitCommitHash = "";
    try {
      gitCommitHash = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: targetDir,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8"
      }).trim();
    } catch (e) {}

    const refinedMarkdown = originalMarkdown + "\nRefined addition.";
    const flagState = { offline: false, refine: true, registry: "skills.sh", alsoLocal: [], install: false };

    // Simulate what headless --refine should cache (verdict: SHIP, markdown: refinedMarkdown)
    const cachedVerdict = {
      schemaVersion: "1",
      target: tempSkillFile,
      skillName: "test-refine-headless",
      dedup: { decision: "BUILD", match: null },
      gateB: { verdict: "SHIP" },
      scoring: {},
      verdict: "SHIP",
      exitCode: 0,
      complete: true,
      markdown: refinedMarkdown,
      notes: "Validation completed. Refinement proposed."
    };
    await writeCache(cacheFile, contentHash, localSourcesHash, "skills.sh", flagState, "", gitCommitHash, cachedVerdict);

    // Run validate in headless mode (CI=true) -> should exit with 2 and propose diff, NOT bypass with 0!
    try {
      execFileSync("node", ["bin/cli.js", "validate", tempSkillFile, "--refine", "--json"], {
        env: { ...process.env, CI: "true" },
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8"
      });
      assert.fail("Should have exited with code 2 due to proposed refinements in headless mode");
    } catch (err) {
      if (err.status !== 2 || !err.stdout) {
        console.error("CHILD PROCESS ERROR STDERR:", err.stderr);
        console.error("CHILD PROCESS ERROR STDOUT:", err.stdout);
      }
      assert.equal(err.status, 2);
      let parsed;
      try {
        parsed = JSON.parse(err.stdout);
      } catch (e) {
        console.error("JSON PARSE ERROR on stdout:", err.stdout);
        throw e;
      }
      if (parsed.verdict !== "FIX") {
        console.error("CHILD PROCESS VERDICT WAS NOT FIX. Stderr was:\n", err.stderr);
        console.error("Stdout was:\n", err.stdout);
      }
      assert.equal(parsed.verdict, "FIX");
      assert.match(parsed.diff, /\+ Refined addition/);
    }

  } finally {
    await fs.unlink(tempSkillFile).catch(() => {});
    await fs.unlink(cacheFile).catch(() => {});
  }
});

test("Concurrent prompt-only state file writes do not cause corruption", async () => {
  const tempSkillFile = path.resolve("./test-concurrent-state.SKILL.md");
  await fs.writeFile(tempSkillFile, "---\nname: test-concurrent-state\ndescription: Some trigger-rich description of at least twenty characters.\n---\nThis is a long body of at least one hundred characters to pass the new validation lint conventions. We must keep adding text here to reach the threshold.\n\n## Verification\nRun tests.", "utf8");

  const pathHash = crypto.createHash("sha256").update(tempSkillFile).digest("hex");
  const stateFile = path.resolve(`.agents/validate-state-${pathHash}.json`);

  try {
    await fs.unlink(stateFile).catch(() => {});

    // Run 5 concurrent processes executing the init step
    const runs = Array.from({ length: 5 }, () => {
      return new Promise((resolve) => {
        execFile("node", ["bin/cli.js", "validate", tempSkillFile, "--prompt-only", "--json"], {
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf8"
        }, (err) => {
          if (err) {
            resolve(err.code || err.status || 1);
          } else {
            resolve(0);
          }
        });
      });
    });

    const results = await Promise.all(runs);
    for (const code of results) {
      assert.equal(code, 1); // intermediate exits should always be 1
    }

    // Verify that the resulting state file is clean and parseable JSON
    const content = await fs.readFile(stateFile, "utf8");
    const parsed = JSON.parse(content);
    assert.equal(parsed.step, "scoring");
    assert.equal(parsed.targetFile, tempSkillFile);

  } finally {
    await fs.unlink(tempSkillFile).catch(() => {});
    await fs.unlink(stateFile).catch(() => {});
  }
});

