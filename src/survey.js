import fs from "fs/promises";
import path from "path";
import { execSync } from "child_process";
import { log } from "./utils.js";

// Helper to convert gitignore patterns to regular expressions.
// Only used by the non-git fallback walker; git repos use `git ls-files`,
// which applies real gitignore semantics (negation, anchoring, **).
function parseGitignore(content) {
  const rules = [];
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Simple glob-to-regex conversion
    let regexStr = trimmed
      .replace(/\./g, "\\.")
      .replace(/\*\*/g, ".*")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, ".");

    if (trimmed.startsWith("/")) {
      regexStr = "^" + regexStr;
    } else {
      regexStr = "(^|/)" + regexStr;
    }

    if (trimmed.endsWith("/")) {
      regexStr = regexStr + ".*";
    } else {
      regexStr = regexStr + "($|/)";
    }

    try {
      rules.push(new RegExp(regexStr));
    } catch (e) {
      // Ignore invalid regexes
    }
  }

  return rules;
}

// Default directories to exclude regardless of .gitignore
const DEFAULT_EXCLUDES = [
  /(^|\/)\.git($|\/)/,
  /(^|\/)node_modules($|\/)/,
  /(^|\/)\.agents($|\/)/,
  /(^|\/)dist($|\/)/,
  /(^|\/)build($|\/)/,
  /(^|\/)out($|\/)/,
  /(^|\/)\.next($|\/)/,
  /(^|\/)\.nuxt($|\/)/,
  /(^|\/)\.venv($|\/)/,
  /(^|\/)venv($|\/)/,
  /(^|\/)env($|\/)/,
  /(^|\/)vendor($|\/)/,
  /(^|\/)\.cache($|\/)/,
];

/**
 * Exclusion list for a run: the defaults plus the run's artifact output
 * directory. `.agents` is hardcoded above, but a custom --out-dir (e.g. the
 * docs-suggested ".claude") would otherwise be surveyed as ordinary repo
 * content on a re-mine — letting Detect propose self-referential candidates
 * evidenced by the tool's own prior SKILL.md/agent output.
 */
export function buildSurveyExcludes(outDir) {
  const normalized = (outDir || "").replace(/^\.\//, "").replace(/[/\\]+$/, "");
  if (!normalized || normalized === ".") return DEFAULT_EXCLUDES;
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...DEFAULT_EXCLUDES, new RegExp(`^${escaped}($|[/\\\\])`)];
}

// Walk the directory recursively and return a list of relative file paths
async function walkDir(dir, gitignoreRules = [], baseDir = dir, excludes = DEFAULT_EXCLUDES) {
  let results = [];
  let list;
  try {
    list = await fs.readdir(dir);
  } catch (err) {
    return results;
  }

  for (const file of list) {
    const filePath = path.join(dir, file);
    const relativePath = path.relative(baseDir, filePath);

    if (excludes.some(rx => rx.test(relativePath) || rx.test(filePath))) {
      continue;
    }
    if (gitignoreRules.some(rx => rx.test(relativePath))) {
      continue;
    }

    let stat;
    try {
      stat = await fs.lstat(filePath);
    } catch (err) {
      continue;
    }

    // Skip symlinks — lstat does not follow them, so no path traversal outside baseDir
    if (stat.isSymbolicLink()) {
      log.warn(`Skipping symlink: ${relativePath}`);
      continue;
    }

    if (stat.isDirectory()) {
      const subResults = await walkDir(filePath, gitignoreRules, baseDir, excludes);
      results = results.concat(subResults);
    } else {
      results.push(relativePath);
    }
  }

  return results;
}

// List tracked + untracked-but-not-ignored files via git (correct ignore
// semantics). `-z` + core.quotepath=false: emit raw NUL-separated paths so
// non-ASCII and newline-containing filenames survive verbatim — otherwise
// git C-quotes them and the literal `"src/caf\303\251.js"` enters allPaths,
// breaking evidence verification (false "fabricated" flags).
function listFilesViaGit(targetDir, excludes = DEFAULT_EXCLUDES) {
  const output = execSync("git -c core.quotepath=false ls-files -z --cached --others --exclude-standard", {
    cwd: targetDir,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  return output
    .split("\0")
    .filter(Boolean)
    .filter(p => !excludes.some(rx => rx.test(p)));
}

/**
 * Parse `git log --pretty=format: --name-only` output into per-file change counts.
 * With an empty pretty format, commit separator lines are blank, so every
 * non-empty line is a file path — no fragile header heuristics.
 */
export function parseChurn(nameOnlyLog) {
  const counts = {};
  for (const line of nameOnlyLog.split("\n")) {
    const file = line.trim();
    if (!file) continue;
    counts[file] = (counts[file] || 0) + 1;
  }
  return counts;
}

function topEntries(counts, limit, excludes = DEFAULT_EXCLUDES) {
  return Object.entries(counts)
    .filter(([file]) => !excludes.some(rx => rx.test(file)))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([file, count]) => ({ file, count }));
}

/**
 * Summarize the file list as a top-level directory tree with file counts,
 * so the LLM sees the repo's shape instead of an arbitrary path subset.
 */
export function buildTreeSummary(paths) {
  const dirCounts = {};
  for (const p of paths) {
    const idx = p.indexOf("/");
    const top = idx === -1 ? "(root)" : p.slice(0, idx);
    dirCounts[top] = (dirCounts[top] || 0) + 1;
  }
  return Object.entries(dirCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([dir, count]) => `${dir === "(root)" ? dir : dir + "/"} — ${count} file${count === 1 ? "" : "s"}`)
    .join("\n");
}

// Histogram of file extensions — tells the LLM what languages live here.
export function buildExtHistogram(paths) {
  const counts = {};
  for (const p of paths) {
    const base = path.basename(p);
    const dot = base.lastIndexOf(".");
    const ext = dot > 0 ? base.slice(dot) : "(no ext)";
    counts[ext] = (counts[ext] || 0) + 1;
  }
  return topEntries(counts, 20)
    .map(({ file, count }) => `${file}: ${count}`)
    .join(", ");
}

// Run git commands to gather churn, bug-fix density, and recent history.
function getGitData(targetDir, excludes = DEFAULT_EXCLUDES) {
  const data = {
    isGit: false,
    headCommit: null,
    hotspots: [],
    bugFixHotspots: [],
    recentCommits: [],
  };

  try {
    execSync("git rev-parse --is-inside-work-tree", { cwd: targetDir, stdio: "ignore" });
    data.isGit = true;

    data.headCommit = execSync("git rev-parse HEAD", { cwd: targetDir, encoding: "utf8" }).trim();

    const commits = execSync("git log -n 50 --oneline", { cwd: targetDir, encoding: "utf8" });
    data.recentCommits = commits.split("\n").filter(Boolean);

    // Churn over the last 500 commits
    const churnLog = execSync("git log -n 500 --pretty=format: --name-only", {
      cwd: targetDir, encoding: "utf8", maxBuffer: 50 * 1024 * 1024,
    });
    data.hotspots = topEntries(parseChurn(churnLog), 20, excludes);

    // Files most touched by fix/revert/bug commits — pain concentration
    try {
      const fixLog = execSync(
        "git log -n 500 --pretty=format: --name-only --regexp-ignore-case --extended-regexp --grep='fix|revert|bug'",
        { cwd: targetDir, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 }
      );
      data.bugFixHotspots = topEntries(parseChurn(fixLog), 15, excludes);
    } catch (err) {
      // No matching commits is fine
    }
  } catch (err) {
    // Not a git repo or git is not installed
  }

  return data;
}

// Per-file TODO/FIXME/HACK counts via `git grep -c` (cheap, bounded output).
function getPainMarkers(targetDir, isGit) {
  if (!isGit) {
    return { total: 0, topFiles: [], available: false };
  }
  try {
    const output = execSync("git grep -c -E 'TODO|FIXME|HACK' -- ':!*.lock'", {
      cwd: targetDir, encoding: "utf8", maxBuffer: 10 * 1024 * 1024,
    });
    const entries = output
      .split("\n")
      .filter(Boolean)
      .map(line => {
        const sep = line.lastIndexOf(":");
        return { file: line.slice(0, sep), count: parseInt(line.slice(sep + 1), 10) || 0 };
      });
    const total = entries.reduce((sum, e) => sum + e.count, 0);
    const topFiles = entries.sort((a, b) => b.count - a.count).slice(0, 15);
    return { total, topFiles, available: true };
  } catch (err) {
    // git grep exits 1 on no matches
    return { total: 0, topFiles: [], available: true };
  }
}

// Read key config files in the project
const CONFIG_NAMES = [
  "package.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "composer.json",
  "Gemfile",
  "mix.exs",
  "pom.xml",
  "build.gradle",
  "requirements.txt",
  "README.md",
  "CONTRIBUTING.md",
  "docker-compose.yml",
  "Dockerfile",
  "tsconfig.json",
  "Makefile",
  "Justfile",
  "Taskfile.yml",
];

const CONFIG_TRUNCATE = 4000;
const README_TRUNCATE = 8000;
const MAX_WORKFLOW_FILES = 5;

async function readConfigs(targetDir, paths) {
  const configs = {};

  const targets = [];
  for (const name of CONFIG_NAMES) {
    const found = paths.find(
      p => p.toLowerCase() === name.toLowerCase() || p.toLowerCase().endsWith("/" + name.toLowerCase())
    );
    if (found) targets.push(found);
  }

  // All CI workflow files, not just two hardcoded names
  const workflows = paths
    .filter(p => p.startsWith(".github/workflows/") && /\.ya?ml$/.test(p))
    .slice(0, MAX_WORKFLOW_FILES);
  targets.push(...workflows);

  for (const relPath of targets) {
    try {
      let content = await fs.readFile(path.join(targetDir, relPath), "utf8");
      const cap = /readme/i.test(relPath) ? README_TRUNCATE : CONFIG_TRUNCATE;
      if (content.length > cap) {
        content = content.substring(0, cap) + "\n... [TRUNCATED] ...";
      }
      configs[relPath] = content;
    } catch (err) {
      // Ignore read errors
    }
  }

  return configs;
}

// Source-file extensions worth sampling for convention detection
const SAMPLE_EXTS = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".go", ".rs", ".rb",
  ".java", ".kt", ".swift", ".php", ".c", ".cc", ".cpp", ".h", ".cs", ".sql", ".sh",
]);

const MAX_SAMPLES = 12;
const SAMPLE_TRUNCATE = 4000;

function isSampleable(p) {
  return SAMPLE_EXTS.has(path.extname(p));
}

/**
 * Pick representative source files: churn hotspots first (highest leverage),
 * then entry points, then a few test files — capped so the Detect context
 * stays bounded. This is what lets Detect see conventions, domain rules,
 * and error-handling style instead of guessing from filenames.
 */
export function pickSampleFiles(paths, hotspots) {
  const pathSet = new Set(paths);
  const picked = [];
  const pickedSet = new Set();

  const add = (p) => {
    if (picked.length < MAX_SAMPLES && pathSet.has(p) && isSampleable(p) && !pickedSet.has(p)) {
      picked.push(p);
      pickedSet.add(p);
    }
  };

  for (const { file } of hotspots) add(file);

  const entryRe = /(^|\/)(index|main|app|cli|server)\.[a-z]+$/;
  for (const p of paths) {
    if (picked.length >= MAX_SAMPLES) break;
    if (entryRe.test(p)) add(p);
  }

  let testCount = 0;
  for (const p of paths) {
    if (picked.length >= MAX_SAMPLES || testCount >= 3) break;
    if (/(^|\/)(tests?|__tests__|spec)\//.test(p) || /\.(test|spec)\./.test(p)) {
      const before = picked.length;
      add(p);
      if (picked.length > before) testCount++;
    }
  }

  return picked;
}

async function readSamples(targetDir, samplePaths) {
  const samples = {};
  for (const relPath of samplePaths) {
    try {
      let content = await fs.readFile(path.join(targetDir, relPath), "utf8");
      if (content.length > SAMPLE_TRUNCATE) {
        content = content.substring(0, SAMPLE_TRUNCATE) + "\n... [TRUNCATED] ...";
      }
      samples[relPath] = content;
    } catch (err) {
      // Ignore read errors
    }
  }
  return samples;
}

// Perform the full survey. `outDir` is the run's artifact output directory —
// it is excluded from the survey (see buildSurveyExcludes) so prior mined
// output never feeds a later mining pass.
export async function surveyProject(targetDir, { outDir } = {}) {
  log.info(`Surveying project at: ${targetDir}`);

  const absoluteTarget = path.resolve(targetDir);
  const excludes = buildSurveyExcludes(outDir);

  // Get git data first — file listing strategy depends on it
  log.step("Querying Git history...");
  const gitData = getGitData(absoluteTarget, excludes);

  let paths;
  if (gitData.isGit) {
    log.step("Listing files via git ls-files...");
    paths = listFilesViaGit(absoluteTarget, excludes);
  } else {
    log.step("Not a git repository — walking directory with .gitignore fallback...");
    let gitignoreRules = [];
    try {
      const gitignoreContent = await fs.readFile(path.join(absoluteTarget, ".gitignore"), "utf8");
      gitignoreRules = parseGitignore(gitignoreContent);
    } catch (err) {
      // No .gitignore; default excludes only
    }
    paths = await walkDir(absoluteTarget, gitignoreRules, absoluteTarget, excludes);
  }
  log.step(`Found ${paths.length} files (excluding ignored/build paths)`);

  if (gitData.isGit) {
    log.step(`Identified ${gitData.hotspots.length} churn hotspots, ${gitData.bugFixHotspots.length} bug-fix hotspots.`);
  }

  log.step("Scanning pain markers (TODO/FIXME/HACK)...");
  const painMarkers = getPainMarkers(absoluteTarget, gitData.isGit);
  if (painMarkers.available) {
    log.step(`Found ${painMarkers.total} pain markers across ${painMarkers.topFiles.length} top files`);
  }

  log.step("Reading key configuration and documentation files...");
  const configs = await readConfigs(absoluteTarget, paths);
  log.step(`Loaded contents of ${Object.keys(configs).length} key files`);

  log.step("Sampling representative source files...");
  const samplePaths = pickSampleFiles(paths, gitData.hotspots);
  const sourceSamples = await readSamples(absoluteTarget, samplePaths);
  log.step(`Sampled ${Object.keys(sourceSamples).length} source files for convention detection`);

  const treeSummary = buildTreeSummary(paths);
  const extHistogram = buildExtHistogram(paths);

  // Bounded path subset for prompts; full list kept for evidence verification
  let fileListStr = paths.slice(0, 300).join("\n");
  if (paths.length > 300) {
    fileListStr += `\n... and ${paths.length - 300} more files (see tree summary for full shape).`;
  }

  return {
    path: targetDir,
    absolutePath: absoluteTarget,
    filesCount: paths.length,
    filesList: fileListStr,
    allPaths: paths,
    treeSummary,
    extHistogram,
    git: gitData,
    configs,
    painMarkers,
    sourceSamples,
  };
}
