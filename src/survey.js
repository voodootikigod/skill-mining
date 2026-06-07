import fs from "fs/promises";
import path from "path";
import { execSync } from "child_process";
import { log } from "./utils.js";

// Helper to convert gitignore patterns to regular expressions
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

// Walk the directory recursively and return a list of files
async function walkDir(dir, gitignoreRules = [], baseDir = dir) {
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
    
    // Check default excludes
    if (DEFAULT_EXCLUDES.some(rx => rx.test(relativePath) || rx.test(filePath))) {
      continue;
    }
    
    // Check .gitignore rules
    if (gitignoreRules.some(rx => rx.test(relativePath))) {
      continue;
    }

    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch (err) {
      continue;
    }

    if (stat.isDirectory()) {
      const subResults = await walkDir(filePath, gitignoreRules, baseDir);
      results = results.concat(subResults);
    } else {
      results.push({
        path: relativePath,
        size: stat.size,
      });
    }
  }

  return results;
}

// Run git commands to find churn and recent commit messages
function getGitData(targetDir) {
  const data = {
    isGit: false,
    hotspots: [],
    recentCommits: [],
  };

  try {
    // Check if it is a git repo
    execSync("git rev-parse --is-inside-work-tree", { cwd: targetDir, stdio: "ignore" });
    data.isGit = true;

    // Get recent commits (last 50)
    const commits = execSync("git log -n 50 --oneline", { cwd: targetDir, encoding: "utf8" });
    data.recentCommits = commits.split("\n").filter(Boolean);

    // Get file churn: list of files sorted by number of changes in recent history
    const logOutput = execSync("git log --name-only --oneline -n 150", { cwd: targetDir, encoding: "utf8" });
    const fileCounts = {};
    const lines = logOutput.split("\n");
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.split(" ").length > 1) {
        // Skip commit headers/messages (which contain spaces)
        continue;
      }
      // Simple path check to filter out commits or noise
      if (trimmed.includes("/")) {
        fileCounts[trimmed] = (fileCounts[trimmed] || 0) + 1;
      } else if (trimmed.includes(".") && !trimmed.startsWith("commit")) {
        fileCounts[trimmed] = (fileCounts[trimmed] || 0) + 1;
      }
    }

    data.hotspots = Object.entries(fileCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([file, count]) => ({ file, count }));

  } catch (err) {
    // Not a git repo or git is not installed
  }

  return data;
}

// Read key config files in the project
async function readConfigs(targetDir, filesList) {
  const configs = {};
  const configNames = [
    "package.json",
    "pyproject.toml",
    "go.mod",
    "Cargo.toml",
    "README.md",
    "docker-compose.yml",
    "Dockerfile",
    ".github/workflows/ci.yml",
    ".github/workflows/build.yml",
    "tsconfig.json",
    "Makefile"
  ];

  for (const name of configNames) {
    // Check if file is in filesList (or matches it)
    const found = filesList.find(f => f.path.toLowerCase() === name.toLowerCase() || f.path.toLowerCase().endsWith("/" + name.toLowerCase()));
    if (found) {
      try {
        const filePath = path.join(targetDir, found.path);
        let content = await fs.readFile(filePath, "utf8");
        // Truncate to first 4000 characters to prevent huge files from swelling context
        if (content.length > 4000) {
          content = content.substring(0, 4000) + "\n... [TRUNCATED] ...";
        }
        configs[found.path] = content;
      } catch (err) {
        // Ignore read errors
      }
    }
  }

  return configs;
}

// Perform the full survey
export async function surveyProject(targetDir) {
  log.info(`Surveying project at: ${targetDir}`);
  
  // Resolve absolute path
  const absoluteTarget = path.resolve(targetDir);
  
  // Try to load gitignore
  let gitignoreRules = [];
  try {
    const gitignoreContent = await fs.readFile(path.join(absoluteTarget, ".gitignore"), "utf8");
    gitignoreRules = parseGitignore(gitignoreContent);
    log.step("Loaded .gitignore rules");
  } catch (err) {
    log.step("No .gitignore found, using default exclusions");
  }

  // Walk directory
  log.step("Walking directory files...");
  const filesList = await walkDir(absoluteTarget, gitignoreRules);
  log.step(`Found ${filesList.length} files (excluding ignored/build paths)`);

  // Get git data
  log.step("Querying Git history...");
  const gitData = getGitData(absoluteTarget);
  if (gitData.isGit) {
    log.step(`Found Git repository. Identified ${gitData.hotspots.length} file hotspots.`);
  } else {
    log.step("Git history unavailable or not a Git repository.");
  }

  // Read config files
  log.step("Reading key configuration and documentation files...");
  const configs = await readConfigs(absoluteTarget, filesList);
  log.step(`Loaded contents of ${Object.keys(configs).length} key files`);

  // Format file listing for context (limit to first 300 files to keep context small, but indicate total)
  let fileListStr = filesList.slice(0, 300).map(f => f.path).join("\n");
  if (filesList.length > 300) {
    fileListStr += `\n... and ${filesList.length - 300} more files.`;
  }

  return {
    path: targetDir,
    absolutePath: absoluteTarget,
    filesCount: filesList.length,
    filesList: fileListStr,
    git: gitData,
    configs: configs,
  };
}
