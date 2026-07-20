import { llmCall } from "./llm.js";
import { log } from "./utils.js";

const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// A description that never says when to load the skill is undiscoverable —
// length alone doesn't prove trigger-richness. The skill template's own
// description style ("Use when ...") must pass this.
const TRIGGER_PHRASE_RE = /\b(use when|use for|when you|triggers? on)\b/i;

/**
 * Minimal frontmatter parser — enough to validate the fields skill loaders
 * depend on (name, description), without a YAML dependency. Handles plain
 * `key: value` pairs and folded block scalars (`key: >-` style).
 */
export function parseFrontmatter(markdown) {
  const text = (markdown || "").replace(/^﻿/, "");
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    return { ok: false, error: "missing frontmatter open delimiter (---)", data: null, body: text };
  }

  const lines = text.split("\n");
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    return { ok: false, error: "frontmatter never closed (no closing ---)", data: null, body: text };
  }

  const data = {};
  let currentKey = null;
  let blockMode = false;

  for (let i = 1; i < closeIdx; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const isIndented = /^\s/.test(line);
    if (isIndented && currentKey && blockMode) {
      data[currentKey] = (data[currentKey] ? data[currentKey] + " " : "") + line.trim();
      continue;
    }
    if (isIndented) continue; // nested mapping (e.g. metadata:) — not validated here

    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (!m) {
      return { ok: false, error: `unparseable frontmatter line ${i + 1}: "${line.trim()}"`, data: null, body: text };
    }
    currentKey = m[1];
    const value = m[2].trim();
    if (value === ">-" || value === ">" || value === "|" || value === "|-") {
      blockMode = true;
      data[currentKey] = "";
    } else {
      blockMode = false;
      data[currentKey] = value.replace(/^["']|["']$/g, "");
    }
  }

  const body = lines.slice(closeIdx + 1).join("\n");
  return { ok: true, error: null, data, body };
}

/**
 * Lint a single authored skill artifact. Returns an array of error strings
 * (empty = clean). `dirFiles` is the list of files that will ship in the
 * skill directory — used to catch dangling references/ links.
 */
export function lintSkillArtifact({ name, markdown, dirFiles = ["SKILL.md"] }) {
  const errors = [];
  const fm = parseFrontmatter(markdown);

  if (!fm.ok) {
    errors.push(`frontmatter: ${fm.error}`);
    return errors;
  }

  if (!fm.data.name) {
    errors.push("frontmatter: missing required field `name`");
  } else {
    if (!KEBAB_RE.test(fm.data.name)) {
      errors.push(`frontmatter: name "${fm.data.name}" is not kebab-case`);
    }
    if (name && fm.data.name !== name) {
      errors.push(`frontmatter: name "${fm.data.name}" does not match skill directory name "${name}"`);
    }
  }

  if (!fm.data.description || fm.data.description.length < 20) {
    errors.push("frontmatter: `description` missing or too short to be trigger-rich (< 20 chars)");
  } else if (!TRIGGER_PHRASE_RE.test(fm.data.description)) {
    errors.push("frontmatter: description lacks a trigger phrase");
  }

  if (!fm.body || fm.body.trim().length < 100) {
    errors.push("body: skill body is empty or trivially short");
  }

  if (!/^##\s+verification/im.test(fm.body || "")) {
    errors.push("body: missing `## Verification` section — an unverifiable skill cannot improve");
  }

  // Dangling references/ links: every references/<path> mentioned must ship
  const refMentions = [...new Set(((fm.body || "").match(/references\/[\w./-]+/g) || []))];
  const shipped = new Set(dirFiles);
  for (const ref of refMentions) {
    if (!shipped.has(ref)) {
      errors.push(`body: dangling reference "${ref}" — file is not part of the skill directory`);
    }
  }

  return errors;
}

// Cross-artifact check: duplicate skill names
export function lintSkillSet(skills) {
  const errors = [];
  const seen = new Set();
  for (const s of skills) {
    if (seen.has(s.name)) {
      errors.push(`duplicate skill name: "${s.name}"`);
    }
    seen.add(s.name);
  }
  return errors;
}

// Light lint for composed agent definitions
export function lintAgentArtifact({ name, markdown }) {
  const errors = [];
  const fm = parseFrontmatter(markdown);
  if (!fm.ok) {
    errors.push(`frontmatter: ${fm.error}`);
    return errors;
  }
  if (!fm.data.name) {
    errors.push("frontmatter: missing required field `name`");
  } else if (name && fm.data.name !== name) {
    errors.push(`frontmatter: name "${fm.data.name}" does not match agent file name "${name}"`);
  }
  if (!fm.data.description) {
    errors.push("frontmatter: missing required field `description`");
  }
  return errors;
}

/**
 * Lint an authored skill; on failure, ask the strong model for a surgical
 * repair (fix ONLY the lint errors), then re-lint. One repair round; a skill
 * that still fails is returned with its errors so the caller can fail closed.
 */
export async function lintWithRepair(llmConfig, skill) {
  let errors = lintSkillArtifact({ name: skill.name, markdown: skill.rawMarkdown });
  if (errors.length === 0) {
    return { ...skill, lintErrors: [] };
  }

  log.warn(`Lint failed for "${skill.name}": ${errors.length} error(s). Attempting one repair round...`);
  for (const e of errors) log.substep(e);

  const repairPrompt = `
=== SKILL.md with lint errors ===
${skill.rawMarkdown}

=== Lint errors ===
${errors.map(e => `- ${e}`).join("\n")}

=== Task ===
Fix ONLY the lint errors listed above. Do not change any other content, wording,
commands, or paths. The frontmatter \`name\` must be exactly "${skill.name}".
Return the corrected raw SKILL.md markdown ONLY — no code fences, no commentary.
`;
  const repaired = await llmCall(
    llmConfig,
    repairPrompt,
    "You are a precise markdown/frontmatter repair tool. Return only the corrected file content.",
    false,
    "strong"
  );

  const repairedMarkdown = repaired.trim();
  errors = lintSkillArtifact({ name: skill.name, markdown: repairedMarkdown });
  if (errors.length === 0) {
    log.substep(`Repair succeeded for "${skill.name}"`);
    return { ...skill, rawMarkdown: repairedMarkdown, lintErrors: [] };
  }

  return { ...skill, lintErrors: errors };
}
