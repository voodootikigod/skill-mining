import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

// Helper to compute sha256 of a string or buffer
export function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

// Helper to recursively get all files in a directory
async function getAllFiles(dir, baseDir = dir) {
  let results = [];
  let list;
  try {
    list = await fs.readdir(dir);
  } catch (err) {
    return results;
  }

  for (const file of list) {
    const filePath = path.join(dir, file);
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch (err) {
      continue;
    }

    if (stat.isDirectory()) {
      const subResults = await getAllFiles(filePath, baseDir);
      results = results.concat(subResults);
    } else {
      results.push(path.relative(baseDir, filePath));
    }
  }

  return results;
}

/**
 * Generates the manifest lines and whole-directory fingerprint for a skill.
 * Returns { manifestText, fingerprint, files: { relativePath: hash } }
 */
export async function generateSkillFingerprint(skillDirPath, skillName) {
  const files = await getAllFiles(skillDirPath);
  const fileHashes = [];

  for (const relPath of files) {
    try {
      const content = await fs.readFile(path.join(skillDirPath, relPath));
      const hash = sha256(content);
      fileHashes.push({ relPath, hash });
    } catch (err) {
      // Ignore files we cannot read
    }
  }

  // Sort alphabetically by relative path
  fileHashes.sort((a, b) => a.relPath.localeCompare(b.relPath));

  // Construct manifest lines
  const manifestLines = fileHashes.map(fh => `${fh.relPath}   sha256:${fh.hash}`);
  const manifestBody = manifestLines.join("\n");
  
  // Fingerprint is the sha256 of the sorted manifest lines (excluding the comment header)
  const fingerprint = sha256(manifestBody);

  const timestamp = new Date().toISOString();
  const manifestText = [
    `# ${skillName} — manifest @ ${timestamp}`,
    manifestBody
  ].join("\n");

  const filesMap = {};
  fileHashes.forEach(fh => {
    filesMap[fh.relPath] = fh.hash;
  });

  return {
    manifestText,
    fingerprint: `sha256:${fingerprint}`,
    files: filesMap
  };
}

/**
 * Verifies a skill directory against an expected fingerprint and file list.
 * Throws an error with details if verification fails.
 */
export async function verifySkillFingerprint(skillDirPath, skillName, expectedFingerprint) {
  // Generate current fingerprint
  let current;
  try {
    current = await generateSkillFingerprint(skillDirPath, skillName);
  } catch (err) {
    throw new Error(`Failed to read skill directory for "${skillName}" at ${skillDirPath}: ${err.message}`);
  }

  if (Object.keys(current.files).length === 0) {
    throw new Error(`Skill directory for "${skillName}" at ${skillDirPath} is empty or does not exist.`);
  }

  if (current.fingerprint !== expectedFingerprint) {
    throw new Error(
      `Fingerprint mismatch for skill "${skillName}"!\n` +
      `  Expected: ${expectedFingerprint}\n` +
      `  Actual:   ${current.fingerprint}\n` +
      `The skill contents have been modified or corrupted since the last full verification run.`
    );
  }

  return current;
}
