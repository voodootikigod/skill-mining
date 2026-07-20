import { extractPathTokens } from "./evidence.js";

// Deterministic grounding of an AUTHORED SKILL.md against the survey — the
// authored body is LLM output, so every path and npm-script it cites must be
// re-checked against ground truth before Gate B spends review rounds on it.
// No LLM, never throws: a grounding crash must not take down the pipeline,
// so garbage input degrades to "no defects found".

// Frontmatter is template boilerplate (license, metadata, the skill's own
// name) — only the body makes checkable claims about the repo.
function stripFrontmatter(text) {
  if (!text.startsWith("---")) return text;
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? text.slice(m[0].length) : text;
}

// Artifacts the mining run itself writes — a skill legitimately names its own
// output files without them existing in the surveyed repo yet.
const SELF_ARTIFACT_RE = /^(?:\.agents\/|\.claude\/|SKILL\.md$|AGENT\.md$|SKILLS_MINED\.(?:md|json)$)/;

// Script references: `npm run X` (also npx run-adjacent pnpm/yarn run forms),
// plus bare `pnpm X` / `yarn X` which invoke package scripts directly.
// Whitespace is [ \t]+, never \s+: a line ending in "pnpm" must not chain onto
// the next line's first word and mint a fabricated script name (while consuming
// — and thus skipping — the real command on that next line).
const RUN_SCRIPT_RE = /\b(?:npm|pnpm|yarn)[ \t]+run[ \t]+([\w:.@-]+)/g;
const DIRECT_SCRIPT_RE = /\b(?:pnpm|yarn)[ \t]+(?!run\b)([\w:.@-]+)/g;

// Trailing sentence punctuation is not part of a script name — prose like
// "run via `npm run test`." must resolve to the real script "test", not a
// fabricated "test.".
const stripTrailingPunct = (s) => s.replace(/[.,;:)\]]+$/, "");

// Bare `pnpm X` / `yarn X` is only a script invocation when written as a
// command. In prose the word after the package-manager name is usually just
// English ("works with pnpm or npm"), so the direct-invocation check looks
// ONLY inside fenced code blocks and inline code spans — silence beats
// false defects.
const FENCE_RE = /```[^\n]*\n([\s\S]*?)```/g;
function extractCodeText(body) {
  const chunks = [];
  for (const m of body.matchAll(FENCE_RE)) chunks.push(m[1]);
  const noFences = body.replace(FENCE_RE, " ");
  for (const m of noFences.matchAll(/`([^`\n]+)`/g)) chunks.push(m[1]);
  return chunks.join("\n");
}

// Package-manager builtins that are NOT script names — `pnpm install` must
// not be flagged as a missing "install" script. Lifecycle aliases (test,
// start, ...) DO resolve to scripts, so they stay checkable.
const PM_BUILTINS = new Set([
  "install", "i", "add", "remove", "rm", "uninstall", "update", "up",
  "upgrade", "link", "unlink", "publish", "pack", "exec", "dlx", "create",
  "init", "run", "why", "list", "ls", "outdated", "audit", "config", "cache",
  "help", "version", "login", "logout", "prune", "rebuild", "root", "import",
  "store", "setup", "fetch", "patch", "node", "env", "ci", "info", "bin",
  "global", "workspace", "workspaces",
  // Package-manager names themselves ("corepack enable pnpm" boilerplate,
  // `yarn npm audit` forms) are never script names.
  "npm", "npx", "pnpm", "yarn",
]);

// pnpm and yarn-classic fall back to executing node_modules/.bin binaries for
// non-builtin, non-script words — `pnpm tsc --noEmit` is legitimate when
// typescript is installed even with no "tsc" script. Most binaries share their
// package's name (vitest, jest, eslint, ...), so a direct dependency-name match
// covers them; the common bin-name/package-name mismatches are aliased here.
const BIN_PACKAGE_ALIASES = {
  tsc: ["typescript"],
  tsserver: ["typescript"],
  playwright: ["playwright", "@playwright/test"],
};

function isDependencyBinary(word, deps) {
  if (deps.has(word)) return true;
  return (BIN_PACKAGE_ALIASES[word] || []).some(pkg => deps.has(pkg));
}

// Best-effort scripts + dependency-name extraction from the surveyed
// package.json text. The survey may hold a truncated excerpt — if it does not
// parse, return null so the caller skips script checks entirely (silence beats
// false defects). Dependency names feed the bare-invocation check: a word that
// resolves to an installed binary is not a missing script.
function parsePackage(configs) {
  const raw = configs?.["package.json"];
  if (typeof raw !== "string") return null;
  try {
    const pkg = JSON.parse(raw);
    if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) return null;
    const scripts = (typeof pkg.scripts === "object" && pkg.scripts !== null && !Array.isArray(pkg.scripts))
      ? pkg.scripts
      : {}; // valid package.json, no scripts — every script ref is a defect
    const depNames = (field) =>
      (typeof pkg[field] === "object" && pkg[field] !== null && !Array.isArray(pkg[field]))
        ? Object.keys(pkg[field])
        : [];
    const deps = new Set([...depNames("dependencies"), ...depNames("devDependencies")]);
    return { scripts, deps };
  } catch {
    return null;
  }
}

// Same existence semantics as verifyCandidateEvidence: exact path or any
// directory prefix of a surveyed path counts as real.
function buildExistsCheck(allPaths) {
  const pathSet = new Set(allPaths);
  const dirSet = new Set();
  for (const p of allPaths) {
    const parts = String(p).split("/");
    for (let i = 1; i < parts.length; i++) {
      dirSet.add(parts.slice(0, i).join("/"));
    }
  }
  const exists = (token) => {
    const t = token.replace(/^\.\//, "").replace(/\/+$/, "");
    return pathSet.has(t) || dirSet.has(t);
  };
  const isRealDir = (segment) => dirSet.has(segment);
  return { exists, isRealDir };
}

// npm package specifiers are not repo paths. Scoped packages
// (@anthropic-ai/sdk) are recognizable outright; bare-import subpaths
// (react-dom/client) are skipped when the token has no file extension and
// its first segment is not a real repo directory.
const NPM_SCOPED_RE = /^@[\w.-]+\//;

/**
 * Ground an authored SKILL.md against the survey. Returns human-readable
 * defect strings (empty array = clean). Deterministic, never throws.
 */
export function groundSkillArtifact(markdown, survey) {
  try {
    const defects = [];
    const body = stripFrontmatter(String(markdown ?? ""));

    // --- Path grounding ---
    const allPaths = Array.isArray(survey?.allPaths) ? survey.allPaths : [];
    if (allPaths.length > 0) {
      const { exists, isRealDir } = buildExistsCheck(allPaths);
      const tokens = extractPathTokens(body).filter(t => !SELF_ARTIFACT_RE.test(t));
      for (const token of tokens) {
        if (exists(token)) continue;
        if (NPM_SCOPED_RE.test(token)) continue;
        const segments = token.replace(/^\.\//, "").split("/");
        const hasFileExt = /\.\w+$/.test(segments[segments.length - 1]);
        if (segments.length > 1 && !hasFileExt && !isRealDir(segments[0])) continue;
        defects.push(`cited path ${token} does not exist in the repo`);
      }
    }

    // --- npm-script grounding ---
    const pkg = parsePackage(survey?.configs);
    if (pkg !== null) {
      const { scripts, deps } = pkg;
      const realScripts = Object.keys(scripts);
      const realList = realScripts.length > 0 ? realScripts.join(", ") : "none";
      const seen = new Set();
      const flag = (command, script) => {
        if (seen.has(command) || realScripts.includes(script)) return;
        seen.add(command);
        defects.push(`command "${command}" references a script not in package.json (real scripts: ${realList})`);
      };
      for (const m of body.matchAll(RUN_SCRIPT_RE)) {
        flag(stripTrailingPunct(m[0]), stripTrailingPunct(m[1]));
      }
      // Direct invocations are only checked in code context (see extractCodeText)
      for (const m of extractCodeText(body).matchAll(DIRECT_SCRIPT_RE)) {
        const script = stripTrailingPunct(m[1]);
        if (script && !PM_BUILTINS.has(script) && !script.startsWith("-") && !isDependencyBinary(script, deps)) {
          flag(stripTrailingPunct(m[0]), script);
        }
      }
    }

    return [...new Set(defects)];
  } catch {
    // Grounding is a guard, not load-bearing — fail open rather than abort.
    return [];
  }
}
