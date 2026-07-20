import { createRequire } from "node:module";

// Single source of truth for the CLI version — read from package.json so a
// release bump never has to touch a second hardcoded site (HELP_TEXT drift).
const require = createRequire(import.meta.url);
export const PACKAGE_VERSION = require("../package.json").version;

// ANSI Escape code helpers for terminal styling without external packages
export const colors = {
  reset: (text) => `${text}\x1b[0m`,
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
  dim: (text) => `\x1b[2m${text}\x1b[22m`,
  red: (text) => `\x1b[31m${text}\x1b[39m`,
  green: (text) => `\x1b[32m${text}\x1b[39m`,
  yellow: (text) => `\x1b[33m${text}\x1b[39m`,
  blue: (text) => `\x1b[34m${text}\x1b[39m`,
  magenta: (text) => `\x1b[35m${text}\x1b[39m`,
  cyan: (text) => `\x1b[36m${text}\x1b[39m`,
  gray: (text) => `\x1b[90m${text}\x1b[39m`,
};

// Help text to display when requested
export const HELP_TEXT = `
${colors.bold(`SKILL MINING CLI v${PACKAGE_VERSION}`)}
Point an agent at a codebase, extract latent skills and agents as durable artifacts.

${colors.bold("Usage:")}
  npx skill-mining mine [path-or-scope] [options]
  (or: npx mine [path-or-scope] [options], npx mine-skills [path-or-scope] [options])
  
  npx skill-mining validate <path-to-SKILL.md> [options]

${colors.bold("Options:")}
  --no-agents, --skills-only    Skip Phase 6 entirely. Mine skills + report only.
  --no-team                     Build agent personas, but standalone — no team manifest.
  --agents-only                 Skip skills; (re)compose agents + team from existing report.
  --report-only                 Re-emit SKILLS_MINED.md from prior results; author nothing.
  --offline                     Run in offline mode (allow search failures without failing closed).
  --out-dir <dir>               Root directory for skill/agent artifacts (default: .agents).
                                SKILLS_MINED.md/json always stay at the repo root.
  --dry-run                     Run detection through the dedupe decision, print the candidate
                                ledger, and exit without writing anything to disk.
  --provider <name>             Force LLM provider: gemini | openai | anthropic.
  --model <name>                Force one LLM model for every phase (sets both tiers).
  --model-strong <name>         Model for judgment-heavy phases (Detect, Gates, Author, Compose).
  --model-fast <name>           Model for mechanical phases (Score, Dedupe decision, manifest).
  --gate-model <name>           Separate model for adversarial Gates A/B (cross-model independence).
  -v, --version                 Print the CLI version and exit.
  -h, --help                    Show this help message.

${colors.bold("Validation Subcommand Options:")}
  --json                        Prints schema-valid JSON verdict to stdout, and logs to stderr.
  --prompt-only                 Keyless mode: prints LLM prompt to stdout/stderr and exits.
  --registry <file>             Path to custom skills registry (default: skills.sh).
  --also-local <dir>            Extra directory to check for duplicate skills (can be repeated).
  --install                     Install verified skill on SHIP verdict.
  --quiet                       Suppress non-essential output.
  --refine                      Propose body edits as a diff.
  --force                       Bypass the validation cache.

${colors.bold("Environment Variables:")}
  ANTHROPIC_API_KEY             Required if using Anthropic provider (default).
  GEMINI_API_KEY                Required if using Gemini provider.
  OPENAI_API_KEY                Required if using OpenAI provider.
`;

// Simple argument parser
export function parseArgs(argv) {
  const args = {
    command: null,
    target: null,
    noAgents: false,
    noTeam: false,
    agentsOnly: false,
    reportOnly: false,
    offline: false,
    outDir: ".agents",
    // True only when the user passed --out-dir with a value — partial modes
    // use this to let an explicit flag beat the sidecar's recorded outDir
    // (the sidecar only ever beats the DEFAULT).
    outDirExplicit: false,
    dryRun: false,
    version: false,
    provider: null,
    model: null,
    modelStrong: null,
    modelFast: null,
    gateModel: null,
    help: false,
    json: false,
    promptOnly: false,
    registry: null,
    alsoLocal: [],
    install: false,
    quiet: false,
    refine: false,
    force: false,
  };

  const positional = [];
  const unknownOptions = [];

  function getFlagValue(flagName) {
    if (i + 1 < argv.length) {
      const nextArg = argv[i + 1];
      if (!nextArg.startsWith("-")) {
        i++;
        return nextArg;
      }
    }
    throw new Error(`Option "${flagName}" requires a value.`);
  }

  let i;
  for (i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else if (arg === "-v" || arg === "--version") {
      args.version = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--out-dir") {
      args.outDir = argv[++i];
      args.outDirExplicit = true;
    } else if (arg.startsWith("--out-dir=")) {
      // Everything after the FIRST "=" is the value — split("=")[1] would
      // silently truncate a directory name containing "=".
      args.outDir = arg.slice("--out-dir=".length);
      args.outDirExplicit = true;
    } else if (arg === "--no-agents" || arg === "--skills-only") {
      args.noAgents = true;
    } else if (arg === "--no-team") {
      args.noTeam = true;
    } else if (arg === "--agents-only") {
      args.agentsOnly = true;
    } else if (arg === "--report-only") {
      args.reportOnly = true;
    } else if (arg === "--offline") {
      args.offline = true;
    } else if (arg === "--provider") {
      args.provider = getFlagValue("--provider");
    } else if (arg === "--model") {
      args.model = getFlagValue("--model");
    } else if (arg === "--model-strong") {
      args.modelStrong = getFlagValue("--model-strong");
    } else if (arg === "--model-fast") {
      args.modelFast = getFlagValue("--model-fast");
    } else if (arg === "--gate-model") {
      args.gateModel = getFlagValue("--gate-model");
    } else if (arg.startsWith("--provider=")) {
      args.provider = arg.slice("--provider=".length);
    } else if (arg.startsWith("--model=")) {
      args.model = arg.slice("--model=".length);
    } else if (arg.startsWith("--model-strong=")) {
      args.modelStrong = arg.slice("--model-strong=".length);
    } else if (arg.startsWith("--model-fast=")) {
      args.modelFast = arg.slice("--model-fast=".length);
    } else if (arg.startsWith("--gate-model=")) {
      args.gateModel = arg.slice("--gate-model=".length);
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--prompt-only") {
      args.promptOnly = true;
    } else if (arg === "--registry") {
      args.registry = getFlagValue("--registry");
    } else if (arg.startsWith("--registry=")) {
      args.registry = arg.slice("--registry=".length);
    } else if (arg === "--also-local") {
      args.alsoLocal.push(getFlagValue("--also-local"));
    } else if (arg.startsWith("--also-local=")) {
      args.alsoLocal.push(arg.slice("--also-local=".length));
    } else if (arg === "--install") {
      args.install = true;
    } else if (arg === "--quiet") {
      args.quiet = true;
    } else if (arg === "--refine") {
      args.refine = true;
    } else if (arg === "--force") {
      args.force = true;
    } else if (arg.startsWith("-")) {
      // Unknown option
      unknownOptions.push(arg);
    } else {
      positional.push(arg);
    }
  }

  // Check if first positional is a known command
  if (positional.length > 0 && (positional[0] === "mine" || positional[0] === "mine-skills" || positional[0] === "validate")) {
    args.command = positional.shift();
  }

  if (unknownOptions.length > 0) {
    if (args.command === "validate") {
      throw new Error(`Unknown option "${unknownOptions[0]}"`);
    } else {
      for (const opt of unknownOptions) {
        console.warn(colors.yellow(`Warning: Unknown option "${opt}"`));
      }
    }
  }

  if (positional.length > 0) {
    args.target = positional[0];
  } else if (args.command !== "validate") {
    args.target = ".";
  }

  // Precedence rules
  if (args.noAgents) {
    args.noTeam = true;
  }

  // A bare/empty --out-dir must not resolve artifact paths to the repo root
  if (!args.outDir) {
    args.outDir = ".agents";
    args.outDirExplicit = false;
  }

  return args;
}

// The only decisions a candidate may carry. Any LLM-produced decision string
// is validated against this — an unrecognized token (case drift, "Build",
// "REUSED") otherwise flows downstream and silently vanishes at authoring.
export const VALID_DECISIONS = new Set(["BUILD", "REUSE", "EXTEND", "REJECT", "DEFER"]);

// A package reference safe to interpolate into a copy-paste `npx skills add`
// command. `source` comes from LLM output over untrusted repo content, so it
// must be charset-validated before it reaches a runnable instruction. The
// first segment may carry a single leading "@" (scoped refs: @org/repo[@ver]).
const PACKAGE_REF_RE = /^@?[\w.-]+\/[\w.-]+(@[\w.:/-]+)?$/;

export function isSafePackageRef(source) {
  return typeof source === "string" && PACKAGE_REF_RE.test(source.trim());
}

/**
 * Bounded-concurrency map. The returned array preserves input order regardless
 * of completion order. A rejection from fn rejects the whole call — callers
 * whose per-item failures must not abort siblings keep their try/catch INSIDE
 * fn (the same place the sequential loops kept it), so one item's failure
 * resolves that slot instead of propagating.
 */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

let jsonMode = false;
let quietMode = false;

// Custom log helpers for premium console output
export const log = {
  setJsonMode: (val) => { jsonMode = !!val; },
  setQuietMode: (val) => { quietMode = !!val; },
  info: (msg) => { if (quietMode) return; (jsonMode ? console.error : console.log)(`${colors.blue("ℹ")} ${msg}`); },
  success: (msg) => { if (quietMode) return; (jsonMode ? console.error : console.log)(`${colors.green("✔")} ${msg}`); },
  warn: (msg) => { if (quietMode) return; console.warn(`${colors.yellow("⚠")} ${msg}`); },
  error: (msg) => console.error(`${colors.red("✖")} ${msg}`),
  phase: (num, name) => {
    if (quietMode) return;
    const logger = jsonMode ? console.error : console.log;
    logger();
    logger(colors.bold(colors.cyan(`=== Phase ${num}: ${name} ===`)));
  },
  gate: (letter, name) => {
    if (quietMode) return;
    const logger = jsonMode ? console.error : console.log;
    logger();
    logger(colors.bold(colors.magenta(`=== ⟂ Gate ${letter}: ${name} (Adversarial) ===`)));
  },
  step: (msg) => { if (quietMode) return; (jsonMode ? console.error : console.log)(`  ${colors.dim("▪")} ${msg}`); },
  substep: (msg) => { if (quietMode) return; (jsonMode ? console.error : console.log)(`    ${colors.gray("↳")} ${msg}`); },
  errorTrace: (err) => {
    console.error(colors.red(err.stack || err.message || err));
  }
};
