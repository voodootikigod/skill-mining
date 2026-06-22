import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";
import { execFileSync, execFile } from "child_process";
import readline from "readline";
import {
  log,
  colors,
  isSafePackageRef
} from "./utils.js";
import {
  llmCallJson,
  configureLLM,
  cleanJsonResponse
} from "./llm.js";
import {
  parseFrontmatter,
  lintSkillArtifact
} from "./lint.js";
import {
  findEcosystemSkills
} from "./dedupe.js";
import {
  runGateB,
  buildGroundTruth
} from "./gates.js";
import {
  surveyProject
} from "./survey.js";

// Helper to compute sha256 of a string
function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

// Helper to clean raw markdown response (strip code fences wrapping response)
export function cleanMarkdownResponse(text) {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    const lines = cleaned.split("\n");
    if (lines[0].startsWith("```") && lines[lines.length - 1].startsWith("```") && lines.length > 1) {
      lines.shift();
      lines.pop();
      cleaned = lines.join("\n").trim();
    }
  }
  return cleaned;
}

function clampScore(val) {
  const num = Math.round(Number(val));
  if (isNaN(num)) return 3;
  return Math.max(1, Math.min(5, num));
}

function isSafeLocalRef(ref) {
  const SAFE_LOCAL_REF_RE = /^[a-zA-Z0-9._/\\]+([-a-zA-Z0-9._/\\]+)*$/;
  const trimmed = (ref || "").trim();
  const isAbsolute = trimmed.startsWith("/") || trimmed.startsWith("\\") || /^[a-zA-Z]:/.test(trimmed);
  return typeof ref === "string" && SAFE_LOCAL_REF_RE.test(trimmed) && !trimmed.includes("..") && !isAbsolute;
}

export async function getRelativeFilesRecursive(baseDir) {
  const fileList = [];
  const visited = new Set();
  const skipDirs = new Set([".git", "node_modules", ".agents", ".adlc"]);

  async function walk(currentDir) {
    const resolved = path.resolve(currentDir);
    if (visited.has(resolved)) return;
    visited.add(resolved);

    if (fileList.length >= 500) return;

    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      if (skipDirs.has(entry.name)) continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          const real = await fs.realpath(fullPath);
          const resolvedBase = path.resolve(baseDir);
          if (real === resolvedBase || real.startsWith(resolvedBase + path.sep)) {
            const stat = await fs.stat(real);
            if (stat.isDirectory()) {
              await walk(real);
            } else if (stat.isFile() && fileList.length < 500) {
              const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, "/");
              fileList.push(relativePath);
            }
          }
        } catch (e) {}
      } else if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && fileList.length < 500) {
        const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, "/");
        fileList.push(relativePath);
      }
    }
  }
  await walk(baseDir);
  return fileList;
}

export async function findProjectRoot(startDir) {
  let current = path.resolve(startDir);
  for (let i = 0; i < 20; i++) {
    try {
      const stat = await fs.stat(path.join(current, ".git"));
      if (stat.isDirectory()) return current;
    } catch (e) {}
    try {
      const stat = await fs.stat(path.join(current, ".agents"));
      if (stat.isDirectory()) return current;
    } catch (e) {}
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(startDir);
}

// Generate simple line-by-line diff between two texts
export function generateDiff(oldText, newText) {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const n = oldLines.length;
  const m = newLines.length;

  if (n * m > 4000000) {
    return "(diff suppressed: file content too large for detail view)";
  }

  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  let i = n;
  let j = m;
  const diff = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diff.push(`+ ${newLines[j - 1]}`);
      j--;
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      diff.push(`- ${oldLines[i - 1]}`);
      i--;
    }
  }

  return diff.reverse().join("\n");
}

// Custom parser to extract provenance from raw frontmatter
export function extractProvenance(rawContent) {
  // Constrain scan to the frontmatter block only to prevent matching body text
  const text = (rawContent || "").replace(/^﻿/, "").trimStart();
  const lines = text.split("\n");
  if (lines[0].trim() !== "---") return null;
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) return null;
  const frontmatterText = lines.slice(1, closeIdx).join("\n");

  const match = frontmatterText.match(/provenance:\s*\n((?:\s{2,}.*\n?)*)/);
  if (!match) {
    // Check flat frontmatter format
    const flatSizeMatch = frontmatterText.match(/(?:provenance_cluster_size|provenance-cluster-size|clusterSize|cluster_size):\s*(\d+)/i);
    const flatEvidenceMatch = frontmatterText.match(/(?:provenance_evidence|provenance-evidence):\s*["']?(.*?)["']?$/mi);
    if (flatSizeMatch) {
      const val = flatEvidenceMatch ? flatEvidenceMatch[1].replace(/^["']|["']$/g, "").trim() : "";
      return {
        clusterSize: parseInt(flatSizeMatch[1], 10),
        evidence: val ? [val] : []
      };
    }
    return null;
  }
  
  const provenanceBlock = match[1];
  const clusterSizeMatch = provenanceBlock.match(/(?:clusterSize|cluster_size):\s*(\d+)/i);
  const clusterSize = clusterSizeMatch ? parseInt(clusterSizeMatch[1], 10) : null;
  
  const evidenceLines = [];
  const evidenceMatch = provenanceBlock.match(/(?:evidence|provenance_evidence):\s*\n((?:\s+-.*\n?)*)/i);
  if (evidenceMatch) {
    const rawLines = evidenceMatch[1].split("\n");
    for (const line of rawLines) {
      const qMatch = line.match(/^\s*-\s*["']?(.*?)["']?$/);
      if (qMatch) {
        const val = qMatch[1].replace(/^["']|["']$/g, "").trim();
        if (val) {
          evidenceLines.push(val);
        }
      }
    }
  } else {
    // Check for inline JSON array
    const inlineArrayMatch = provenanceBlock.match(/(?:evidence|provenance_evidence):\s*\[(.*?)\]/i);
    if (inlineArrayMatch) {
      try {
        const parsed = JSON.parse(`[${inlineArrayMatch[1]}]`);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            const trimmed = String(item).trim();
            if (trimmed) {
              evidenceLines.push(trimmed);
            }
          }
        }
      } catch (e) {
        const items = inlineArrayMatch[1].split(",");
        for (const item of items) {
          const trimmed = item.trim().replace(/^["']|["']$/g, "").trim();
          if (trimmed) {
            evidenceLines.push(trimmed);
          }
        }
      }
    }
  }
  
  return {
    clusterSize,
    evidence: evidenceLines
  };
}

// Scan local directories for existing skills
export async function getLocalSkills(dirs, excludePath) {
  const localSkills = [];
  const normalizedExclude = path.resolve(excludePath);
  const visited = new Set();

  async function traverse(currentPath) {
    if (localSkills.length >= 500) return;
    const resolved = path.resolve(currentPath);
    if (visited.has(resolved)) return;
    visited.add(resolved);

    let entries;
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      if (localSkills.length >= 500) return;
      const fullPath = path.join(currentPath, entry.name);
      const resolvedPath = path.resolve(fullPath);
      if (resolvedPath === normalizedExclude) continue;

      let isFile = entry.isFile();
      let isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          const real = await fs.realpath(fullPath);
          const resolvedDir = path.resolve(currentPath);
          if (real === resolvedDir || real.startsWith(resolvedDir + path.sep)) {
            const stat = await fs.stat(fullPath);
            isFile = stat.isFile();
            isDirectory = stat.isDirectory();
          }
        } catch (e) {}
      }

      if (isFile) {
        if (entry.name.endsWith(".SKILL.md") || entry.name.endsWith("SKILL.md")) {
          try {
            const content = await fs.readFile(fullPath, "utf8");
            const fm = parseFrontmatter(content);
            if (fm.ok && fm.data.name && fm.data.description) {
              localSkills.push({
                name: fm.data.name,
                description: fm.data.description,
                path: fullPath,
                hash: sha256(content)
              });
            }
          } catch (e) {
            // Ignore individual file read failures
          }
        }
      } else if (isDirectory) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        await traverse(fullPath);
      }
    }
  }

  for (const dir of dirs) {
    if (!dir) continue;
    try {
      const absoluteDir = path.resolve(dir);
      await traverse(absoluteDir);
    } catch (e) {
      // Directory missing/unreadable
    }
  }
  return localSkills;
}

// Compute hash representing local dedup source state
export function computeLocalSourcesHash(localSkills) {
  const sorted = [...localSkills].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const lines = sorted.map(s => `${s.name}:${s.description}:${s.path}:${s.hash || ""}`);
  return sha256(lines.join("\n"));
}

// Resolve install folder from harness list or default
export async function resolveInstallDir(projectRoot, offline = false) {
  // 1. Try reading configuration directly without subprocess (100% safe & offline)
  for (const relPath of [".agents/skills.json", "skills.json"]) {
    try {
      const full = path.join(projectRoot, relPath);
      const data = JSON.parse(fsSync.readFileSync(full, "utf8"));
      if (data && data.path) {
        return path.resolve(projectRoot, data.path);
      }
      if (data && Array.isArray(data.entries)) {
        const proj = data.entries.find(e => e.scope === "project" || e.path);
        if (proj && proj.path) {
          return path.resolve(projectRoot, proj.path);
        }
      }
    } catch (e) {}
  }

  if (offline) {
    return path.join(path.resolve(projectRoot), ".agents", "skills");
  }
  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile("npx", ["--no-install", "skills", "list", "--json"], {
        cwd: projectRoot,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
        timeout: 10000
      }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
    const skills = JSON.parse(stdout);
    const projectSkill = skills.find(s => s.scope === "project");
    if (projectSkill && projectSkill.path) {
      return path.dirname(path.resolve(projectRoot, projectSkill.path));
    }
  } catch (e) {
    // Ignore skills CLI issues
  }
  return path.join(path.resolve(projectRoot), ".agents", "skills");
}

export function normalizeFlags(flags) {
  const normalized = {};
  const keys = Object.keys(flags).sort();
  for (const key of keys) {
    const val = flags[key];
    if (Array.isArray(val)) {
      normalized[key] = [...val].sort();
    } else {
      normalized[key] = val;
    }
  }
  return normalized;
}

// Read stdin helper
async function readStdin() {
  try {
    return fsSync.readFileSync(0, "utf8");
  } catch (err) {
    return "";
  }
}

// Interactive prompt for [y/N]
async function confirmPrompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr, // write question to stderr
  });
  return new Promise((resolve) => {
    rl.question(colors.yellow(`? ${question} (y/N): `), (answer) => {
      rl.close();
      const val = answer.trim().toLowerCase();
      resolve(val === "y" || val === "yes");
    });
  });
}

async function installSkill({ projectRoot, skillName, isDir, targetDir, dirFiles, targetFile, mdToInstall, offline }) {
  const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  if (!KEBAB_RE.test(skillName)) {
    throw new Error(`Sanity check failed: skill name "${skillName}" is not valid kebab-case`);
  }
  const installDir = await resolveInstallDir(projectRoot, !!offline);
  const targetSkillDir = path.join(installDir, skillName);
  await fs.mkdir(targetSkillDir, { recursive: true });
  if (isDir) {
    const ALLOWED_SUBDIRS = ["scripts", "examples", "resources", "references"];
    for (const rel of dirFiles) {
      const parts = rel.split("/");
      const topDir = parts[0];
      const isAllowed = rel === "SKILL.md" || ALLOWED_SUBDIRS.includes(topDir);
      if (!isAllowed) continue;

      const src = path.join(targetDir, rel);
      const dest = path.resolve(targetSkillDir, rel);
      if (dest !== targetSkillDir && !dest.startsWith(targetSkillDir + path.sep)) {
        throw new Error(`Path traversal detected: target path "${rel}" escapes skill directory.`);
      }
      await fs.mkdir(path.dirname(dest), { recursive: true });
      if (rel === "SKILL.md") {
        await fs.writeFile(dest, mdToInstall, "utf8");
      } else {
        await fs.copyFile(src, dest);
        try {
          const srcStat = await fs.stat(src);
          await fs.chmod(dest, srcStat.mode);
        } catch (e) {
          // Ignore chmod failures
        }
      }
    }
  } else {
    await fs.writeFile(path.join(targetSkillDir, "SKILL.md"), mdToInstall, "utf8");
  }
  log.success(`Installed skill "${skillName}" to: ${targetSkillDir}/`);
  return ` Installed skill to: ${targetSkillDir}/`;
}

export async function runValidationCommand(args, passedLlmConfig = null) {
  // Activate logging configuration
  log.setJsonMode(args.json || args.promptOnly);
  log.setQuietMode(args.quiet);

  try {

  const inputPath = args.target;
  if (!inputPath) {
    throw new Error("Validation command requires an input path to a SKILL.md stub.");
  }

  const absoluteInputPath = path.resolve(inputPath);
  let isDir = false;
  let targetFile = absoluteInputPath;
  let skillName = "unknown";
  let stateFile = null;

  function exitWithError(msg, exitCode = 3) {
    if (stateFile) {
      try {
        if (fsSync.existsSync(stateFile)) {
          fsSync.unlinkSync(stateFile);
        }
      } catch (e) {}
    }
    if (args.json) {
      const verdict = {
        schemaVersion: "1",
        target: targetFile,
        skillName,
        dedup: { decision: "REJECT", match: null, sources: [], rationale: `Operational error: ${msg}` },
        gateB: { verdict: "REJECT", task: "n/a", evidence: `Operational error: ${msg}`, missing: [] },
        scoring: { frequency: 0, leverage: 0, bespokeness: 0, stability: 0, verifiability: 0, provenanceUsed: false, rationale: `Operational error: ${msg}` },
        verdict: exitCode === 2 ? "REJECT" : "INCOMPLETE",
        exitCode,
        complete: exitCode === 2,
        notes: `Operational error: ${msg}`
      };
      console.log(JSON.stringify(verdict, null, 2));
    } else {
      log.error(msg);
    }
    process.exit(exitCode);
  }

  try {
    const stat = await fs.stat(absoluteInputPath);
    if (stat.isDirectory()) {
      isDir = true;
      targetFile = path.join(absoluteInputPath, "SKILL.md");
    }
  } catch (e) {
    exitWithError(`File or directory not found at: ${inputPath}`, 3);
  }

  let rawContent;
  try {
    rawContent = await fs.readFile(targetFile, "utf8");
    if (rawContent.startsWith("\uFEFF")) {
      rawContent = rawContent.slice(1);
    }
  } catch (e) {
    exitWithError(`Failed to read SKILL.md file at: ${targetFile}`, 3);
  }

  const targetDir = path.dirname(targetFile);
  // Parse frontmatter first to extract references from fm.body
  const fm = parseFrontmatter(rawContent);
  if (fm.ok) {
    const refMentions = [...new Set(((fm.body || "").match(/references\/[\w./-]+/g) || []))];
    const resolvedTargetDir = path.resolve(targetDir);
    for (const ref of refMentions) {
      const refPath = path.resolve(targetDir, ref);
      if (refPath !== resolvedTargetDir && !refPath.startsWith(resolvedTargetDir + path.sep)) {
        throw new Error(`Path traversal detected: reference "${ref}" escapes target directory.`);
      }
    }
  }
  
  let dirFiles;
  if (isDir) {
    dirFiles = await getRelativeFilesRecursive(targetDir);
    if (dirFiles.length === 0) {
      dirFiles = ["SKILL.md"];
    }
  } else {
    dirFiles = ["SKILL.md"];
    const refsDir = path.join(targetDir, "references");
    try {
      const stat = await fs.stat(refsDir);
      if (stat.isDirectory()) {
        const refFiles = await getRelativeFilesRecursive(refsDir);
        for (const file of refFiles) {
          dirFiles.push(`references/${file}`);
        }
      }
    } catch (e) {
      // references folder doesn't exist next to the file
    }
  }

  const lintErrors = fm.ok ? lintSkillArtifact({ name: fm.data.name, markdown: rawContent, dirFiles }) : ["Invalid frontmatter structure"];
  if (lintErrors.length > 0) {
    const verdict = {
      schemaVersion: "1",
      target: targetFile,
      skillName: fm.data?.name || "unknown",
      dedup: { decision: "REJECT", match: null, sources: [], rationale: `Lint failures: ${lintErrors.join("; ")}` },
      gateB: { verdict: "REJECT", task: "n/a", evidence: "Lint failures", missing: [] },
      scoring: { frequency: 0, leverage: 0, bespokeness: 0, stability: 0, verifiability: 0, provenanceUsed: false, rationale: "Lint failures" },
      verdict: "REJECT",
      exitCode: 2,
      complete: true,
      notes: `Validation lint failed: ${lintErrors.join("; ")}`
    };
    if (args.json) {
      console.log(JSON.stringify(verdict, null, 2));
    } else {
      for (const err of lintErrors) {
        log.error(`Lint error: ${err}`);
      }
    }
    process.exit(2);
  }

  skillName = fm.data.name;
  let limitedBody = fm.body || "";
  if (limitedBody.length > 80000) {
    log.warn(`Skill body is very large (${limitedBody.length} chars) and will be truncated to 80,000 chars for LLM evaluation.`);
    limitedBody = limitedBody.substring(0, 80000);
  }

  let llmConfig = passedLlmConfig;
  if (!llmConfig) {
    try {
      llmConfig = configureLLM(args);
    } catch (err) {
      exitWithError(`LLM configuration failed: ${err.message}`, 3);
    }
  }

  // Compute compound content hash including referenced files
  const refMentions = [...new Set(((fm.body || "").match(/references\/[\w./-]+/g) || []))];
  const refHashes = [];
  const resolvedTargetDir = path.resolve(targetDir);
  for (const ref of refMentions) {
    const refPath = path.resolve(targetDir, ref);
    if (refPath !== resolvedTargetDir && !refPath.startsWith(resolvedTargetDir + path.sep)) {
      throw new Error(`Path traversal detected: reference "${ref}" escapes target directory.`);
    }
    try {
      const refContent = await fs.readFile(refPath, "utf8");
      refHashes.push(`${ref}:${sha256(refContent)}`);
    } catch (e) {
      // Missing or unreadable file
    }
  }
  const contentHash = sha256(rawContent + "\n" + refHashes.sort().join("\n"));

  const prov = extractProvenance(rawContent);
  const rawLines = rawContent.split("\n");
  let closeLineIdx = -1;
  if (rawLines[0] && rawLines[0].trim() === "---") {
    for (let i = 1; i < rawLines.length; i++) {
      if (rawLines[i].trim() === "---") {
        closeLineIdx = i;
        break;
      }
    }
  }
  const frontmatterPart = closeLineIdx !== -1 ? rawLines.slice(0, closeLineIdx + 1).join("\n") : "";
  const hasProvInFrontmatter = frontmatterPart.includes("provenance") || frontmatterPart.includes("cluster_size") || frontmatterPart.includes("clusterSize");
  if (hasProvInFrontmatter && !prov) {
    log.warn("Provenance field was detected in frontmatter but could not be parsed successfully.");
  }

  const projectRoot = await findProjectRoot(targetDir);
  
  const defaultLocalDirs = [
    path.join(targetDir, ".adlc", "lessons"),
    path.join(projectRoot, ".adlc", "lessons"),
    path.join(projectRoot, ".agents", "skills")
  ];
  const scanDirs = [...new Set([...defaultLocalDirs, ...args.alsoLocal].map(d => d ? path.resolve(d) : ""))].filter(Boolean);
  const localSkills = await getLocalSkills(scanDirs, targetFile);
  const localSourcesHash = computeLocalSourcesHash(localSkills);

  const registry = args.registry || "skills.sh";
  const flagState = {
    offline: !!args.offline,
    registry,
    alsoLocal: args.alsoLocal,
    refine: !!args.refine,
    install: !!args.install
  };

  // Hash using targetFile path instead of absoluteInputPath to prevent directory vs file hash fragmentation
  const pathHash = sha256(targetFile);
  const cacheFile = path.join(projectRoot, ".agents", `validate-cache-${pathHash}.json`);
  stateFile = path.join(projectRoot, ".agents", `validate-state-${pathHash}.json`);

  // Read custom registry content hash
  let registryContentHash = "";
  let customRegistrySkills = null;
  let customRegistryContent = "";
  if (registry !== "skills.sh") {
    try {
      customRegistryContent = await fs.readFile(registry, "utf8");
      registryContentHash = sha256(customRegistryContent);
      try {
        const parsed = JSON.parse(customRegistryContent);
        customRegistrySkills = Array.isArray(parsed) ? parsed : (parsed.entries && Array.isArray(parsed.entries)) ? parsed.entries : null;
      } catch (e) {
        // Treated as raw text content
      }
    } catch (e) {
      exitWithError(`Failed to read custom registry file at: ${registry}`, 3);
    }
  }

  // Obtain codebase state fingerprint
  let gitStateFingerprint = "";
  let gitCommitHash = "";
  try {
    gitCommitHash = await new Promise((resolve, reject) => {
      execFile("git", ["rev-parse", "HEAD"], {
        cwd: targetDir,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8"
      }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.trim());
      });
    });
    gitStateFingerprint = gitCommitHash;
  } catch (e) {
    // Not a git repo
  }

  // E8: Idempotency cache check (skip check entirely if in promptOnly mode)
  if (!args.force && !args.promptOnly) {
    const cachedVerdict = await checkCache(cacheFile, contentHash, localSourcesHash, registry, flagState, registryContentHash, gitStateFingerprint);
    if (cachedVerdict) {
      log.info(`Validation cache hit for skill "${skillName}" (cached 24h)`);
      
      let finalVerdict = cachedVerdict.verdict;
      let exitCode = cachedVerdict.exitCode;
      let mdToInstall = rawContent;

      if (args.refine && (cachedVerdict.verdict === "SHIP" || cachedVerdict.verdict === "FIX") && cachedVerdict.markdown && cachedVerdict.markdown !== rawContent) {
        const proposedDiff = generateDiff(rawContent, cachedVerdict.markdown);
        const isHeadless = process.env.CI === "true" || !process.stdin.isTTY;
        if (isHeadless) {
          if (args.json) {
            const verdictJson = {
              ...cachedVerdict,
              verdict: "FIX",
              exitCode: 2,
              diff: proposedDiff,
              notes: (cachedVerdict.notes || "") + " Refinement requested in headless mode."
            };
            console.log(JSON.stringify(verdictJson, null, 2));
          } else {
            console.error(`Proposed refinement diff for "${skillName}":\n${proposedDiff}`);
          }
          log.warn("Refinement requested in headless mode. Cannot prompt for approval. Exiting.");
          process.exit(2);
        } else {
          console.error(`\nProposed Refinement Diff for "${skillName}":\n`);
          console.error(proposedDiff);
          console.error("\n");
          const approved = await confirmPrompt(`Apply proposed fixes to the source file ${inputPath}?`);
          if (approved) {
            await fs.writeFile(targetFile, cachedVerdict.markdown, "utf8");
            log.success(`Applied refinements to: ${targetFile}`);
            cachedVerdict.notes = (cachedVerdict.notes || "") + " Refinement edits applied to target file.";
            mdToInstall = cachedVerdict.markdown;
          } else {
            log.info("Refinement edits rejected.");
            if (finalVerdict === "SHIP") {
              finalVerdict = "FIX";
              exitCode = 2;
              cachedVerdict.verdict = "FIX";
              cachedVerdict.exitCode = 2;
              await writeCache(cacheFile, contentHash, localSourcesHash, registry, flagState, registryContentHash, gitStateFingerprint, cachedVerdict);
            }
          }
        }
      } else if (cachedVerdict.markdown) {
        mdToInstall = cachedVerdict.markdown;
      }

      // Perform cached side effects if applicable AFTER refinement/edits, ONLY if finalVerdict is SHIP
      if (finalVerdict === "SHIP" && args.install) {
        const installNote = await installSkill({ projectRoot, skillName, isDir, targetDir, dirFiles, targetFile, mdToInstall, offline: args.offline });
        cachedVerdict.notes = (cachedVerdict.notes || "") + installNote;
      }

      // Update cachedVerdict's verdict and exitCode if it changed
      cachedVerdict.verdict = finalVerdict;
      cachedVerdict.exitCode = exitCode;

      if (args.json) {
        console.log(JSON.stringify(cachedVerdict, null, 2));
      } else {
        log.success(`Cached verdict: ${cachedVerdict.verdict}`);
      }
      process.exit(exitCode);
    }
  }

  // Load state machine for --prompt-only
  let state = {
    step: "init",
    targetFile,
    contentHash,
    localSourcesHash,
    registry,
    registryContentHash,
    gitCommitHash,
    flags: flagState,
    verdict: null,
    scoring: null,
    dedup: null,
    gateB: null,
    fixRounds: 0,
    markdown: rawContent,
    testTask: null,
    taskOrigin: null,
    objections: []
  };

  if (args.promptOnly) {
    try {
      const saved = await fs.readFile(stateFile, "utf8");
      const parsedState = JSON.parse(saved);
      if (parsedState.targetFile === targetFile &&
          parsedState.contentHash === contentHash &&
          parsedState.localSourcesHash === localSourcesHash &&
          parsedState.registry === registry &&
          (parsedState.registryContentHash || "") === registryContentHash &&
          (parsedState.gitCommitHash || "") === gitCommitHash &&
          JSON.stringify(normalizeFlags(parsedState.flags || {})) === JSON.stringify(normalizeFlags(flagState))) {
        const KNOWN_STEPS = new Set([
          "init", "scoring", "scoring_done", "dedupe", "dedupe_done",
          "synthetic_task", "gateB_review", "gateB_fix", "gateB_done"
        ]);
        if (parsedState.step && KNOWN_STEPS.has(parsedState.step)) {
          state = parsedState;
          log.info(`Resuming validation from state file: step ${state.step}`);
        } else {
          log.warn(`Stale or corrupt validation state file ignored: unknown step "${parsedState.step}"`);
        }
      }
    } catch (e) {
      // New validation run
    }
  }

  // Helper to exit intermediate in --prompt-only
  async function exitPromptOnly(promptText, stepName) {
    state.step = stepName;
    state.pendingPrompt = promptText;
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    const tmpPath = `${stateFile}.${process.pid}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(state, null, 2) + "\n", "utf8");
    await fs.rename(tmpPath, stateFile);

    if (args.json) {
      const intermediateVerdict = {
        schemaVersion: "1",
        target: targetFile,
        skillName,
        dedup: state.dedup,
        gateB: state.gateB,
        scoring: state.scoring,
        verdict: "INCOMPLETE",
        exitCode: 1,
        complete: false,
        prompt: promptText,
        notes: "Awaiting LLM response in prompt-only mode."
      };
      console.log(JSON.stringify(intermediateVerdict, null, 2));
    } else {
      console.log(promptText);
    }
    // Write prompt text to stderr
    console.error(`\n=== KEYLESS PROMPT FOR STEP: ${stepName} ===`);
    console.error(promptText);
    console.error("=========================================\n");
    console.error("Please re-run the command piping the LLM response to stdin.");
    process.exit(1);
  }

  // Read response from stdin if piped
  let stdinResponse = "";
  if (args.promptOnly) {
    if (process.stdin.isTTY) {
      if (state.step !== "init" && state.pendingPrompt) {
        await exitPromptOnly(state.pendingPrompt, state.step);
      }
    } else {
      if (state.step !== "init") {
        stdinResponse = await readStdin();
        if (stdinResponse.trim() === "" && state.pendingPrompt) {
          await exitPromptOnly(state.pendingPrompt, state.step);
        }
      }
    }
  }

  // Scoring Step
  if (state.step === "init") {
    let freq = 3, lev = 3, ver = 3, bsp = 3, stab = 3;
    let provUsed = false;
    let scoreRationale = "Single-stub scoring call.";

    if (prov) {
      provUsed = true;
      if (prov.clusterSize != null) {
        const size = prov.clusterSize;
        freq = size === 1 ? 2 : size <= 3 ? 3 : size <= 5 ? 4 : 5;
      }
      if (prov.evidence && prov.evidence.length > 0) {
        ver = Math.min(5, 3 + prov.evidence.length);
        lev = 4;
      }
      scoreRationale = `Scored using ADLC provenance data (cluster size: ${prov.clusterSize || "n/a"}, evidence quotes: ${prov.evidence?.length || 0}).`;
    }

    if (llmConfig.provider === "prompt-only") {
      let provText = "";
      if (prov) {
        provText = `\nADLC Proven Available: Yes\nProvenance cluster size: ${prov.clusterSize || "n/a"}\nEvidence: ${JSON.stringify(prov.evidence || [])}\n`;
      }
      const promptText = `Please evaluate the following skill stub according to the 5-axis rubric (Frequency, Leverage, Bespokeness, Stability, Verifiability).
${provText}
Return a JSON object only:
{
  "scores": { "freq": 3, "lev": 3, "bsp": 4, "stab": 4, "ver": 4 },
  "rationale": "Why this score was given"
}

Stub Name: ${skillName}
Stub Description: ${fm.data.description}
Stub Body: ${limitedBody}`;
      await exitPromptOnly(promptText, "scoring");
    } else {
      log.step("Evaluating 5-axis scoring for stub...");
      const scoringPrompt = `
You are scoring the candidate skill stub "${skillName}" on a 1-5 scale across 5 axes:
- freq: Frequency of occurrence in the project.
- lev: Leverage (value added by the skill).
- bsp: Bespokeness (how unique to this project vs generic).
- stab: Stability.
- ver: Verifiability.

Stub Name: ${skillName}
Description: ${fm.data.description}
Body: ${limitedBody}
ADLC Provenance Available: ${prov ? "Yes" : "No"}
${prov ? `Provenance cluster size: ${prov.clusterSize}, evidence: ${JSON.stringify(prov.evidence)}` : ""}

Return a JSON object only:
{
  "scores": { "freq": 3, "lev": 3, "bsp": 4, "stab": 4, "ver": 4 },
  "rationale": "Why this score was given"
}
`;
      let res;
      try {
        res = await llmCallJson(llmConfig, scoringPrompt, "Return JSON only.", "fast", "Validate Single-Stub Score");
        freq = prov && prov.clusterSize != null ? freq : clampScore(res.scores?.freq ?? freq);
        lev = prov && prov.evidence && prov.evidence.length > 0 ? lev : clampScore(res.scores?.lev ?? lev);
        bsp = clampScore(res.scores?.bsp ?? bsp);
        stab = clampScore(res.scores?.stab ?? stab);
        ver = prov && prov.evidence && prov.evidence.length > 0 ? ver : clampScore(res.scores?.ver ?? ver);
        if (prov) {
          const provRationale = `[Provenance: cluster size ${prov.clusterSize || "n/a"}, evidence ${prov.evidence?.length || 0}]`;
          scoreRationale = `${provRationale} ${res.rationale || ""}`.trim();
        } else {
          scoreRationale = res.rationale || scoreRationale;
        }
      } catch (err) {
        exitWithError(`LLM scoring failed: ${err.message}`, 3);
      }
    }

    state.scoring = { frequency: freq, leverage: lev, bespokeness: bsp, stability: stab, verifiability: ver, provenanceUsed: provUsed, rationale: scoreRationale };
    state.step = "scoring_done";
  }

  // Apply response if piped to scoring step
  if (state.step === "scoring" && args.promptOnly) {
    try {
      const clean = cleanJsonResponse(stdinResponse);
      const res = JSON.parse(clean);
      if (!res.scores) {
        throw new Error("Piped JSON is missing expected 'scores' object");
      }
      let freq = 3, lev = 3, ver = 3, bsp = 3, stab = 3;
      let scoreRationale = "Piped prompt-only score.";

      if (prov) {
        if (prov.clusterSize != null) {
          const size = prov.clusterSize;
          freq = size === 1 ? 2 : size <= 3 ? 3 : size <= 5 ? 4 : 5;
        }
        if (prov.evidence && prov.evidence.length > 0) {
          ver = Math.min(5, 3 + prov.evidence.length);
          lev = 4;
        }
        const provRationale = `[Provenance: cluster size ${prov.clusterSize || "n/a"}, evidence ${prov.evidence?.length || 0}]`;
        scoreRationale = `${provRationale} ${res.rationale || ""}`.trim();
      } else {
        scoreRationale = res.rationale || scoreRationale;
      }

      state.scoring = {
        frequency: prov && prov.clusterSize != null ? freq : clampScore(res.scores?.freq ?? freq),
        leverage: prov && prov.evidence && prov.evidence.length > 0 ? lev : clampScore(res.scores?.lev ?? lev),
        bespokeness: clampScore(res.scores?.bsp ?? bsp),
        stability: clampScore(res.scores?.stab ?? stab),
        verifiability: prov && prov.evidence && prov.evidence.length > 0 ? ver : clampScore(res.scores?.ver ?? ver),
        provenanceUsed: !!prov,
        rationale: scoreRationale
      };
      state.step = "scoring_done";
      stdinResponse = ""; // consumed
    } catch (e) {
      log.error(`Failed to parse prompt-only scoring response: ${e.message}`);
      process.exit(1);
    }
  }

  // Deduplication Step
  if (state.step === "scoring_done") {
    let ecosystemResult = "";
    if (registry !== "skills.sh") {
      if (customRegistrySkills) {
        const nameTokens = skillName.toLowerCase().split("-");
        const descTokens = fm.data.description.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        const matches = [];
        for (const regSkill of customRegistrySkills) {
          const regName = (regSkill.name || regSkill.id || "").toLowerCase();
          const regDesc = (regSkill.description || "").toLowerCase();
          const nameMatch = nameTokens.some(tok => regName.includes(tok));
          const descMatchCount = descTokens.filter(tok => regName.includes(tok) || regDesc.includes(tok)).length;
          if (nameMatch || descMatchCount >= 2) {
            matches.push(regSkill);
          }
        }
        if (matches.length > 0) {
          ecosystemResult = matches.map(s => `- Match: "${s.name || s.id}" (Description: ${s.description || ""})`).join("\n");
        } else {
          ecosystemResult = "No matching skills found in custom registry file.";
        }
      } else {
        const nameTokens = skillName.toLowerCase().split("-");
        const descTokens = fm.data.description.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        const lines = customRegistryContent.split("\n");
        const matchingLines = [];
        for (const line of lines) {
          const lowerLine = line.toLowerCase();
          const nameMatch = nameTokens.some(tok => lowerLine.includes(tok));
          const descMatchCount = descTokens.filter(tok => lowerLine.includes(tok)).length;
          if (nameMatch || descMatchCount >= 2) {
            matchingLines.push(line.trim());
            if (matchingLines.length >= 10) break;
          }
        }
        if (matchingLines.length > 0) {
          ecosystemResult = `Matches found in custom registry:\n${matchingLines.map(l => `- ${l}`).join("\n")}`;
        } else {
          ecosystemResult = `No matches found in registry file "${registry}".`;
        }
      }
    } else {
      // registry is "skills.sh"
      try {
        const eco = findEcosystemSkills({ name: skillName, description: fm.data.description }, args.promptOnly || !!args.offline);
        if (!eco.success && eco.status === "offline" && !args.promptOnly) {
          state.dedup = {
            decision: "DEFER",
            match: null,
            sources: ["installed", "skills.sh", ".adlc/lessons"].filter(s => {
              if (s === "installed" && localSkills.some(l => l.path.replace(/\\/g, "/").includes(".agents/skills"))) return true;
              if (s === "skills.sh" && !args.offline) return true;
              if (s === ".adlc/lessons" && localSkills.some(l => l.path.replace(/\\/g, "/").includes(".adlc/lessons"))) return true;
              return false;
            }),
            rationale: "Offline mode: reuse-check unavailable, not built (search unavailable)"
          };
          state.step = "dedupe_done";
        } else if ((eco.status === "failed" || eco.status === "partial") && !args.promptOnly) {
          const failed = eco.failedQueries?.join(" / ") || "all variants";
          state.dedup = {
            decision: "DEFER",
            match: null,
            sources: ["installed", "skills.sh", ".adlc/lessons"].filter(s => {
              if (s === "installed" && localSkills.some(l => l.path.replace(/\\/g, "/").includes(".agents/skills"))) return true;
              if (s === "skills.sh" && !args.offline) return true;
              if (s === ".adlc/lessons" && localSkills.some(l => l.path.replace(/\\/g, "/").includes(".adlc/lessons"))) return true;
              return false;
            }),
            rationale: `Reuse search incomplete (failed: ${failed}) — reuse-check unavailable, not built`
          };
          state.step = "dedupe_done";
        } else {
          ecosystemResult = eco.results || "No matching skills found in registry.";
        }
      } catch (e) {
        exitWithError(`Ecosystem search failed for "${skillName}" (registry unreachable or timeout).`, 3);
      }
    }

    const localSkillTexts = localSkills.map(s => `- Local skill: "${s.name}" (Description: ${s.description})`).join("\n");
    const searchOutputStr = `
=== ECOSYSTEM SKILLS (${registry} registry) ===
${ecosystemResult}

=== LOCAL SKILLS ===
${localSkillTexts || "(none)"}
`;

    const dedupePrompt = `
=== Candidate Skill ===
Name: ${skillName}
Description: ${fm.data.description}
Body: ${limitedBody}

=== Ecosystem and Local Search Output ===
${searchOutputStr}

=== Task ===
Determine the final deduplication decision:
- REUSE: if a public or local skill covers this stub (record the exact source name).
- EXTEND: if an existing skill covers the base, but a thin overlay is needed.
- BUILD: if genuinely unique tribal knowledge with no equivalent.
- REJECT: if not worth building.

Return a JSON object only:
{
  "finalDecision": "BUILD",
  "source": "this repo",
  "justification": "Why this decision was made in light of the search results",
  "match": null
}
`;

    if (state.step !== "dedupe_done") {
      if (llmConfig.provider === "prompt-only") {
        await exitPromptOnly(dedupePrompt, "dedupe");
      } else {
        log.step("Deciding reuse-vs-build...");
        const res = await llmCallJson(llmConfig, dedupePrompt, "Return JSON only.", "fast", "Validate Dedupe");
        let finalDecision = String(res.finalDecision || "").toUpperCase();
        if (!VALID_VALIDATE_DECISIONS.has(finalDecision)) finalDecision = "REJECT";

        let match = res.match || null;
        if (!match && (finalDecision === "REUSE" || finalDecision === "EXTEND")) {
          match = res.source || null;
        }
        if (match && !(isSafePackageRef(match) || isSafeLocalRef(match))) {
          log.warn(`Unsafe dedupe match reference detected: "${match}". Reverting to REJECT.`);
          finalDecision = "REJECT";
          match = null;
        }

        state.dedup = {
          decision: finalDecision,
          match: match,
          sources: ["installed", "skills.sh", ".adlc/lessons"].filter(s => {
            if (s === "installed" && localSkills.some(l => l.path.replace(/\\/g, "/").includes(".agents/skills"))) return true;
            if (s === "skills.sh" && !args.offline) return true;
            if (s === ".adlc/lessons" && localSkills.some(l => l.path.replace(/\\/g, "/").includes(".adlc/lessons"))) return true;
            return false;
          }),
          rationale: res.justification || "No justification provided."
        };
        state.step = "dedupe_done";
      }
    }
  }

  // Apply response if piped to dedupe step
  if (state.step === "dedupe" && args.promptOnly) {
    try {
      const clean = cleanJsonResponse(stdinResponse);
      const res = JSON.parse(clean);
      if (!res.finalDecision && !res.decision) {
        throw new Error("Piped JSON is missing expected 'finalDecision' field");
      }
      let finalDecision = String(res.finalDecision || res.decision || "").toUpperCase();
      if (!VALID_VALIDATE_DECISIONS.has(finalDecision)) finalDecision = "REJECT";
      let match = res.match || null;
      if (!match && (finalDecision === "REUSE" || finalDecision === "EXTEND")) {
        match = res.source || null;
      }
      if (match && !(isSafePackageRef(match) || isSafeLocalRef(match))) {
        finalDecision = "REJECT";
        match = null;
      }
      state.dedup = {
        decision: finalDecision,
        match: match,
        sources: ["installed", "skills.sh", ".adlc/lessons"].filter(s => {
          if (s === "installed" && localSkills.some(l => l.path.replace(/\\/g, "/").includes(".agents/skills"))) return true;
          if (s === "skills.sh" && !args.offline) return true;
          if (s === ".adlc/lessons" && localSkills.some(l => l.path.replace(/\\/g, "/").includes(".adlc/lessons"))) return true;
          return false;
        }),
        rationale: res.justification || "No justification provided."
      };
      state.step = "dedupe_done";
      stdinResponse = ""; // consumed
    } catch (e) {
      log.error(`Failed to parse prompt-only dedupe response: ${e.message}`);
      process.exit(1);
    }
  }

  // Setup Gate B Context
  if (state.step === "dedupe_done") {
    const dedupDecision = state.dedup.decision;
    if (dedupDecision === "REUSE" || dedupDecision === "REJECT" || dedupDecision === "DEFER") {
      state.gateB = {
        verdict: "SKIP",
        task: "n/a",
        evidence: `Gate B skipped because deduplication decision was ${dedupDecision}.`,
        missing: []
      };
      state.step = "gateB_done";
    } else {
      if (llmConfig.provider === "prompt-only") {
        const syntheticTaskPrompt = `Given this skill "${skillName}", devise a realistic concrete test task an agent would execute in this codebase:
${fm.body.substring(0, 1000)}
Return one sentence only.`;
        await exitPromptOnly(syntheticTaskPrompt, "synthetic_task");
      } else {
        log.step("Surveying codebase for fact-checking...");
        const realSurvey = await surveyProject(projectRoot);
        const authoredSkills = [{
          name: skillName,
          decision: state.dedup.decision,
          source: state.dedup.match || "this repo",
          justification: state.dedup.rationale,
          rawMarkdown: state.markdown
        }];

        log.step("Running Gate B adversarial review...");
        const { verifiedSkills, rejectedSkills } = await runGateB(llmConfig, authoredSkills, realSurvey);

        if (verifiedSkills.length > 0) {
          const v = verifiedSkills[0];
          state.gateB = {
            verdict: "SHIP",
            task: v.testTask || "synthesized testing task",
            evidence: v.verification || "Usable cold",
            missing: []
          };
          state.markdown = v.rawMarkdown;
          state.step = "gateB_done";
        } else if (rejectedSkills.length > 0) {
          const r = rejectedSkills[0];
          const isFix = r.gateBVerdict === "FIX";
          state.gateB = {
            verdict: isFix ? "FIX" : "REJECT",
            task: r.testTask || "synthesized testing task",
            evidence: r.gateBOutcome,
            missing: [r.gateBOutcome]
          };
          state.markdown = r.rawMarkdown || state.markdown;
          state.step = "gateB_done";
        } else {
          exitWithError("Gate B returned empty validation results.", 3);
        }
      }
    }
  }

  // Intermediate states for prompt-only Gate B
  if (state.step === "synthetic_task" && args.promptOnly) {
    state.testTask = stdinResponse.trim();
    state.taskOrigin = "synthetic (prompt-only)";
    stdinResponse = ""; // consumed

    // Note: surveyProject is purely filesystem-based (no LLM/network calls are made)
    // and is intentionally run in prompt-only mode to populate the grounded codebase context
    // inside the generated Gate B adversarial prompt.
    log.step("Surveying codebase for fact-checking...");
    const realSurvey = await surveyProject(projectRoot);
    const groundTruth = buildGroundTruth(realSurvey);
    const limitedGroundTruth = groundTruth ? groundTruth.substring(0, 100000) : "";

    const gateBPrompt = `
=== Skill Content under Review ===
Name: ${skillName}
Description: ${fm.data.description}
Body:
${state.markdown}

=== Adversarial Review Guidelines (Gate B) ===
Review the skill "${skillName}" against the following test task:
Task: ${state.testTask}

=== REPO GROUND TRUTH (for fact-checking only) ===
${limitedGroundTruth || "(no repo ground truth available)"}

Return a JSON object only:
{
  "verdict": "SHIP",
  "objections": [],
  "requestedEdits": "Exact section/line edits if verdict is FIX"
}
`;
    await exitPromptOnly(gateBPrompt, "gateB_review");
  }

  if (state.step === "gateB_review" && args.promptOnly) {
    try {
      const clean = cleanJsonResponse(stdinResponse);
      const res = JSON.parse(clean);
      if (!res.verdict) {
        throw new Error("Piped JSON is missing expected 'verdict' field");
      }
      let gateVerdict = String(res.verdict || "").toUpperCase();
      if (gateVerdict !== "SHIP" && gateVerdict !== "FIX" && gateVerdict !== "REJECT") {
        gateVerdict = "REJECT";
      }
      state.gateB = {
        verdict: gateVerdict,
        task: state.testTask,
        evidence: (res.objections || []).join("; ") || `Reviewed via prompt-only (${gateVerdict})`,
        missing: res.objections || []
      };
      if (gateVerdict === "FIX") {
        const fixPrompt = `=== Original SKILL.md ===
${state.markdown}

=== Requested Edits ===
${res.requestedEdits || "(none)"}

Apply the fixes. Return ONLY the updated markdown content.`;
        await exitPromptOnly(fixPrompt, "gateB_fix");
      } else {
        state.step = "gateB_done";
      }
      stdinResponse = ""; // consumed
    } catch (e) {
      log.error(`Failed to parse prompt-only Gate B review: ${e.message}`);
      process.exit(1);
    }
  }

  if (state.step === "gateB_fix" && args.promptOnly) {
    state.markdown = cleanMarkdownResponse(stdinResponse);
    stdinResponse = ""; // consumed

    // Multiround fix loop: return to gateB_review
    state.fixRounds = (state.fixRounds || 0) + 1;
    if (state.fixRounds > 2) {
      exitWithError("Maximum refinement rounds (2) exceeded.", 2);
    }

    // Note: surveyProject is purely filesystem-based (no LLM/network calls are made)
    // and is intentionally run in prompt-only mode to populate the grounded codebase context
    // inside the generated Gate B adversarial prompt.
    log.step("Surveying codebase for fact-checking...");
    const realSurvey = await surveyProject(projectRoot);
    const groundTruth = buildGroundTruth(realSurvey);
    const limitedGroundTruth = groundTruth ? groundTruth.substring(0, 100000) : "";

    const gateBPrompt = `
=== Skill Content under Review (Refined Round ${state.fixRounds}) ===
Name: ${skillName}
Description: ${fm.data.description}
Body:
${state.markdown}

=== Adversarial Review Guidelines (Gate B) ===
Review the skill "${skillName}" against the following test task:
Task: ${state.testTask}

=== REPO GROUND TRUTH (for fact-checking only) ===
${limitedGroundTruth || "(no repo ground truth available)"}

Return a JSON object only:
{
  "verdict": "SHIP",
  "objections": [],
  "requestedEdits": "Exact section/line edits if verdict is FIX"
}
`;
    await exitPromptOnly(gateBPrompt, "gateB_review");
  }

  // Reached gateB_done! Now verify final output and compile verdict
  if (state.step === "gateB_done") {
    try {
      await fs.unlink(stateFile);
    } catch (e) {
      // Ignored
    }

    const dedupDecision = state.dedup.decision;
    const gateVerdict = state.gateB.verdict;

    let finalVerdict = "REJECT";
    let exitCode = 2;

    if (dedupDecision === "REUSE") {
      finalVerdict = "REUSE";
      exitCode = 2;
    } else if (dedupDecision === "REJECT") {
      finalVerdict = "REJECT";
      exitCode = 2;
    } else if (dedupDecision === "DEFER") {
      finalVerdict = "DEFER";
      exitCode = 2;
    } else if (dedupDecision === "BUILD" || dedupDecision === "EXTEND") {
      if (gateVerdict === "SHIP") {
        finalVerdict = "SHIP";
        exitCode = 0;
      } else if (gateVerdict === "FIX") {
        finalVerdict = "FIX";
        exitCode = 2;
      } else {
        finalVerdict = "REJECT";
        exitCode = 2;
      }
    } else {
      finalVerdict = "REJECT";
      exitCode = 2;
    }

    // Post-refinement lint check on state.markdown
    if (finalVerdict === "SHIP" || finalVerdict === "FIX") {
      const postLintErrors = lintSkillArtifact({ name: skillName, markdown: state.markdown, dirFiles });
      if (postLintErrors.length > 0) {
        log.warn(`Refined markdown failed post-validation linting: ${postLintErrors.join("; ")}. Discarding proposed refinements.`);
        finalVerdict = "FIX";
        exitCode = 2;
        state.markdown = rawContent; // Revert to original
      }
    }

    const originalMarkdown = rawContent;
    let refinementApplied = false;

    // Check if Gate B made corrections to the original markdown
    if (state.markdown !== originalMarkdown) {
      if (finalVerdict !== "SHIP" && finalVerdict !== "FIX") {
        state.markdown = originalMarkdown; // Revert to original, do not refine
      } else if (args.refine) {
        const proposedDiff = generateDiff(originalMarkdown, state.markdown);
        const isHeadless = process.env.CI === "true" || !process.stdin.isTTY;
        if (isHeadless) {
          const refinedMarkdown = state.markdown;
          state.markdown = originalMarkdown; // Keep original unmutated
          const trueVerdict = {
            schemaVersion: "1",
            target: targetFile,
            skillName,
            dedup: state.dedup,
            gateB: state.gateB,
            scoring: state.scoring,
            verdict: "SHIP",
            exitCode: 0,
            complete: true,
            markdown: refinedMarkdown,
            notes: "Validation execution completed. Refinement proposed."
          };

          if (args.json) {
            const verdictJson = { ...trueVerdict, verdict: "FIX", exitCode: 2, diff: proposedDiff, notes: "Validation execution completed. Refinement requested in headless mode." };
            console.log(JSON.stringify(verdictJson, null, 2));
          } else {
            console.error(`Proposed refinement diff for "${skillName}":\n${proposedDiff}`);
          }
          log.warn("Refinement requested in headless mode. Cannot prompt for approval. Exiting.");
          await writeCache(cacheFile, contentHash, localSourcesHash, registry, flagState, registryContentHash, gitStateFingerprint, trueVerdict);
          process.exit(2);
        } else {
          console.error(`\nProposed Refinement Diff for "${skillName}":\n`);
          console.error(proposedDiff);
          console.error("\n");
          const approved = await confirmPrompt(`Apply proposed fixes to the source file ${inputPath}?`);
          if (approved) {
            await fs.writeFile(targetFile, state.markdown, "utf8");
            log.success(`Applied refinements to: ${targetFile}`);
            refinementApplied = true;
          } else {
            log.info("Refinement edits rejected.");
            state.markdown = originalMarkdown; // Revert to original
            if (finalVerdict === "SHIP") {
              finalVerdict = "FIX";
              exitCode = 2;
            }
          }
        }
      } else {
        // Refine is not enabled, so we cannot apply corrections
        state.markdown = originalMarkdown; // Revert to original
        if (finalVerdict === "SHIP") {
          finalVerdict = "FIX";
          exitCode = 2;
        }
      }
    }

    const verdict = {
      schemaVersion: "1",
      target: targetFile,
      skillName,
      dedup: state.dedup,
      gateB: state.gateB,
      scoring: state.scoring,
      verdict: finalVerdict,
      exitCode,
      complete: true,
      markdown: state.markdown,
      notes: "Validation execution completed."
    };

    if (refinementApplied) {
      verdict.notes += " Refinement edits applied to target file.";
    }

    // E4: Install on SHIP verdict
    if (finalVerdict === "SHIP" && args.install) {
      const installNote = await installSkill({ projectRoot, skillName, isDir, targetDir, dirFiles, targetFile, mdToInstall: state.markdown, offline: args.offline });
      verdict.notes += installNote;
    }

    // Write Cache
    await writeCache(cacheFile, contentHash, localSourcesHash, registry, flagState, registryContentHash, gitStateFingerprint, verdict);

    if (args.json) {
      console.log(JSON.stringify(verdict, null, 2));
    } else {
      log.phase("7", "Validation Verdict Summary");
      log.info(`Deduplication Decision: ${dedupDecision}`);
      log.info(`Gate B Verdict: ${gateVerdict}`);
      if (finalVerdict === "SHIP") {
        log.success(`Final verdict: ${colors.bold(colors.green(finalVerdict))}`);
      } else {
        log.warn(`Final verdict: ${colors.bold(colors.yellow(finalVerdict))}`);
      }
    }
    process.exit(exitCode);
  }
  } finally {
    log.setJsonMode(false);
    log.setQuietMode(false);
  }
}

// Helper to clean response


const VALID_VALIDATE_DECISIONS = new Set(["BUILD", "REUSE", "EXTEND", "REJECT", "DEFER"]);

// Read cache helper
export async function checkCache(cacheFile, contentHash, localSourcesHash, registry, flags, registryContentHash = "", codebaseHash = "") {
  try {
    const raw = await fs.readFile(cacheFile, "utf8");
    const data = JSON.parse(raw);
    const now = Date.now();
    const age = now - (data.timestamp || 0);
    const hours24 = 24 * 60 * 60 * 1000;
    
    const normDataFlags = normalizeFlags(data.flags || {});
    const normInputFlags = normalizeFlags(flags || {});

    if (age < hours24 &&
        data.contentHash === contentHash &&
        data.localSourcesHash === localSourcesHash &&
        data.registry === registry &&
        (data.registryContentHash || "") === registryContentHash &&
        (data.codebaseHash || "") === codebaseHash &&
        JSON.stringify(normDataFlags) === JSON.stringify(normInputFlags)) {
      
      const validVerdicts = new Set(["SHIP", "FIX", "REJECT", "REUSE", "DEFER", "INCOMPLETE"]);
      if (data.verdictJson && 
          typeof data.verdictJson === "object" &&
          validVerdicts.has(data.verdictJson.verdict) &&
          typeof data.verdictJson.exitCode === "number" &&
          [0, 1, 2, 3].includes(data.verdictJson.exitCode)) {
        return data.verdictJson;
      }
    }
  } catch (e) {
    // Cache miss
  }
  return null;
}

// Write cache helper
export async function writeCache(cacheFile, contentHash, localSourcesHash, registry, flags, registryContentHash, codebaseHash, verdictJson) {
  try {
    const data = {
      contentHash,
      localSourcesHash,
      registry,
      registryContentHash: registryContentHash || "",
      codebaseHash: codebaseHash || "",
      flags: normalizeFlags(flags || {}),
      verdictJson,
      timestamp: Date.now()
    };
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    await fs.writeFile(cacheFile, JSON.stringify(data, null, 2) + "\n", "utf8");
  } catch (e) {
    // Ignore cache failures
  }
}
